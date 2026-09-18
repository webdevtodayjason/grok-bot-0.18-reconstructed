#!/usr/bin/env node
// Offline eval harness for the Jev judgments described in docs/JEV-1.md.
//
// It imports no host code, no control plane code and nothing a tester can reach: Node's
// standard library and fetch only. Every case in tests/fixtures/jev-cases.json is synthetic.
//
// The API key is read from the environment variable TYPESAFE_API_KEY and from nowhere else.
// It is never printed, never logged and never written to the output file.
//
// Usage: TYPESAFE_API_KEY=... node scripts/jev-eval.mjs
//          [--cases <path>]       case file, default tests/fixtures/jev-cases.json
//          [--out <path>]         raw output, default tests/fixtures/jev-eval-out.json
//          [--set <label>]        header label, default "tuned set"
//          [--only <substring>] [--concurrency 4]
//
// A case file is {cases: [...]} or a bare array. Only keys present in a case's expected map are
// graded, so a file that omits has_result_<store> or cheapest_rung still runs.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CASES_PATH = resolve(REPO, "tests/fixtures/jev-cases.json");
const DEFAULT_OUT_PATH = resolve(REPO, "tests/fixtures/jev-eval-out.json");
const DEFAULT_SET_LABEL = "tuned set";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const USD_PER_MILLION_INPUT_TOKENS = 0.042;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 600;

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is not set. Export it in the shell that runs this script and try again.");
  process.exit(1);
}

const args = process.argv.slice(2);
const only = readFlag(args, "--only");
const concurrency = Number(readFlag(args, "--concurrency") ?? 4);
// A case file this run must not be read by hand still runs here: point --cases and --out at it.
const CASES_PATH = resolve(process.cwd(), readFlag(args, "--cases") ?? DEFAULT_CASES_PATH);
const OUT_PATH = resolve(process.cwd(), readFlag(args, "--out") ?? DEFAULT_OUT_PATH);
const SET_LABEL = readFlag(args, "--set") ?? DEFAULT_SET_LABEL;

function readFlag(list, name) {
  const at = list.indexOf(name);
  return at === -1 ? undefined : list[at + 1];
}

// ---------------------------------------------------------------------------
// Questions. One set per judgment, worded as in docs/JEV-1.md.
// ---------------------------------------------------------------------------

const JUDGMENT_1_QUESTIONS = {
  scope: {
    type: "choice",
    instructions: "What does the person want to know about where to get this item?",
    criteria: {
      local_in_store:
        "which physical stores near a named or implied place have it on the shelf or for pickup today",
      online_ship: "where it can be ordered online and shipped, place does not matter",
      national_price: "what it costs in general, comparing prices, no store or place named",
      informational: "what the item is, how it works, or advice, not where to buy",
      unclear: "the request does not say enough to tell",
    },
  },
  // The four constraint nouls name `request` by path. The state also carries `workspace_location`,
  // which scope still needs as the implied place, but which is where the person is sitting and not
  // something they asked for. Without the path, every one of these reads the whole state.
  names_stores: {
    type: "noul",
    instructions:
      "Does `request` name one or more specific retailers or store chains by name? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "at least one retailer or chain is named in `request`, such as Home Depot or Ace",
      false: "`request` names no retailer or chain",
    },
  },
  names_location: {
    type: "noul",
    instructions:
      "Does `request` name a city, town, ZIP code, neighbourhood, or say 'near me' or 'local'? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "`request` names a city, town, ZIP code or neighbourhood, or says near me or local",
      false: "`request` names no place and does not say near me or local",
    },
  },
  names_quantity: {
    type: "noul",
    instructions:
      "Does `request` state a required quantity, pack size, or count per package? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "`request` states a number of units or a pack size, such as packs of 10",
      false: "`request` states no quantity or pack size",
    },
  },
  substitutes_ok: {
    type: "noul",
    instructions:
      "Does `request` allow a different size, finish, or pack than the one stated? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "the person says a substitute, similar item, or any size is fine",
      false: "`request` asks for the exact item as stated, or says nothing about substitutes",
    },
  },
};

const JUDGMENT_2_BASE_QUESTIONS = {
  satisfies: {
    type: "choice",
    instructions: "Do the results answer the request as constrained?",
    criteria: {
      fully:
        "at least one result is a listing at a named store, in the stated pack size, with stock or pickup for the stated place",
      partially:
        "results show the item or the pack size but not for a specific store near the place, or for a store not named",
      // Disjoint from cannot_tell on purpose. The old wording, "no result shows the item in any
      // stated pack size", was also true whenever a snippet said nothing at all, so a state that
      // could not be judged read as a settled no.
      no: "a result clearly shows the item and it is not in any stated pack size",
      cannot_tell: "the snippets do not say enough to judge",
    },
  },
  // One noul per rung, so Jev never applies an ordering. Code holds the order below and picks the
  // cheapest rung at or above the floor. Several rungs are true at once on a typical result set,
  // which is exactly why this is no longer a single choice.
  can_answer_now: {
    type: "noul",
    instructions: "Do the results already give a store-level answer for every named store in the stated pack size?",
    criteria: {
      true: "every store in `constraints.stores_named` has a result showing the item in a stated pack size with stock or pickup at a store for the place",
      false: "at least one named store has no store-level result, or no result shows a stated pack size",
    },
  },
  // Separate from can_answer_now on purpose. can_answer_now asks whether the results MATCH the
  // request at store level. This one asks whether an honest reply can be written at all, which
  // includes the honest reply that the item does not appear at the stores the results cover.
  answerable_now: {
    type: "noul",
    instructions:
      "Can an honest and complete answer be written from these results now, including the answer that the exact item or variant does not exist or is not sold in that pack anywhere the results cover?",
    criteria: {
      true: "the results settle the request for everything they cover, so a reply can be written now, whether that reply is the item at a store or that it does not appear at the stores covered",
      false: "a named store or a stated constraint is still unsettled, or the snippets say too little to write anything honest",
    },
  },
  needs_more_sources: {
    type: "noul",
    instructions: "Is a named store missing from the results entirely?",
    criteria: {
      true: "at least one store in `constraints.stores_named` has no result of any kind in the results list",
      false: "every store in `constraints.stores_named` has at least one result, whatever that result says",
    },
  },
  needs_page_fetch: {
    type: "noul",
    instructions: "Does a result's page likely carry the pack size or store pickup detail its snippet lacks?",
    criteria: {
      true: "at least one result's snippet is missing the pack size or the store pickup detail, and its page would plainly carry it",
      false: "the snippets already carry that detail, or it sits behind a store selection, a sign-in or a block that a plain fetch cannot pass",
    },
  },
  needs_tinyfish: {
    type: "noul",
    instructions: "Did a needed page refuse a plain fetch or need rendering?",
    criteria: {
      true: "a result records a refused fetch, a block, or a page that needs rendering before it shows anything",
      false: "no result records a refused fetch or a page that needs rendering",
    },
  },
  needs_desktop_browser: {
    type: "noul",
    instructions: "Does a store-level stock answer need a store to be selected on the site?",
    criteria: {
      true: "a result says stock is shown only once a store is selected on the site or once someone signs in",
      false: "no result says that, because stock is already shown or the site does not gate it behind a store selection",
    },
  },
};

// The rung order is code's, cheapest first, and the floor is the plan's 0.6.
// answer_now is picked when EITHER of its two nouls clears the floor: the results match the
// request, or an honest reply can be written from what they cover.
const RUNG_ORDER = [
  { questions: ["can_answer_now", "answerable_now"], rung: "answer_now" },
  { questions: ["needs_more_sources"], rung: "search_more_sources" },
  { questions: ["needs_page_fetch"], rung: "fetch_pages" },
  { questions: ["needs_tinyfish"], rung: "tinyfish" },
  { questions: ["needs_desktop_browser"], rung: "desktop_browser" },
];
const RUNG_FLOOR = 0.6;

function pickRung(answers) {
  for (const { questions, rung } of RUNG_ORDER) {
    for (const question of questions) {
      const answer = answers?.[question];
      if (answer && answer.type === "noul" && answer.noul >= RUNG_FLOOR) return rung;
    }
  }
  return "none";
}

// A universal negative answered "supports" below this confidence reads as no_evidence in code.
const UNIVERSAL_NEGATIVE_FLOOR = 0.6;

// Judgment 2b, constraint confirmation: one result at a time, one noul per constraint, each asked
// about the fields it can be answered from. Fetch is not keyed on pack size; it is keyed on any
// constraint the constraints themselves make required going unconfirmed.
const JUDGMENT_2B_QUESTIONS = {
  confirms_item: {
    type: "noul",
    instructions:
      "Do `result.title` and `result.snippet` show the exact item named in `constraints.item`, the same size, finish and type, not a variant?",
    criteria: {
      true: "`result.title` or `result.snippet` names the same item as `constraints.item`, matching its size, its finish and its type",
      false: "the result is a variant, a different size, a different finish or a different type, or the item cannot be told from `result.title` and `result.snippet`",
    },
  },
  confirms_pack_size: {
    type: "noul",
    instructions: "Does `result.title` or `result.snippet` state a package count equal to one of `constraints.pack_sizes`?",
    criteria: {
      true: "`result.title` or `result.snippet` states a package count and it is one of the numbers in `constraints.pack_sizes`",
      false: "no package count is stated, or the count that is stated is not one of the numbers in `constraints.pack_sizes`",
    },
  },
  confirms_store: {
    type: "noul",
    instructions:
      "Is the result from a retailer named in `constraints.stores_named`? Judge it from `result.source` and `result.title`.",
    criteria: {
      true: "`result.source` or `result.title` is one of the retailers listed in `constraints.stores_named`",
      false: "the result comes from a site that is not listed in `constraints.stores_named`, or `constraints.stores_named` is empty",
    },
  },
  confirms_stock_for_location: {
    type: "noul",
    instructions:
      "Does `result.snippet` or `result.title` state stock, pickup or availability at a store in or near `constraints.location`?",
    criteria: {
      true: "`result.snippet` or `result.title` names a store in or near `constraints.location` and says the item is in stock, ready for pickup, or available there",
      false: "no store in or near `constraints.location` is named with stock, pickup or availability, or the result only offers shipping or asks the reader to check their own store",
    },
  },
};

// Code derives the required set from the constraints. It never reads the label.
const CONFIRMATION_FLOOR = 0.6;
function requiredConfirmations(constraints) {
  const required = ["confirms_item", "confirms_stock_for_location"];
  if ((constraints?.pack_sizes ?? []).length > 0) required.push("confirms_pack_size");
  if ((constraints?.stores_named ?? []).length > 0) required.push("confirms_store");
  return required;
}
function decideFetch(answers, required) {
  const unconfirmed = required.filter((question) => !(answers?.[question]?.noul >= CONFIRMATION_FLOOR));
  return { fetch: unconfirmed.length > 0, unconfirmed };
}

const JUDGMENT_3_QUESTIONS = {
  support: {
    type: "choice",
    instructions: "How does the evidence relate to the claim?",
    criteria: {
      supports: "the evidence states the claim or directly implies it",
      contradicts: "the evidence states the opposite or shows a case the claim rules out",
      no_evidence: "the evidence does not speak to the claim either way",
    },
  },
  is_universal_negative: {
    type: "noul",
    instructions:
      "Does the claim say that no store, nobody, or no source at all has the item, rather than that the checked sources did not show it?",
    criteria: {
      true: "the claim is about everyone or everywhere",
      false: "the claim is scoped to the sources named as checked, or is not a negative",
    },
  },
};

function storeSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function questionsFor(testCase) {
  if (testCase.judgment === 1) return { ...JUDGMENT_1_QUESTIONS };
  if (testCase.judgment === 3) return { ...JUDGMENT_3_QUESTIONS };
  if (testCase.judgment === "2b") return { ...JUDGMENT_2B_QUESTIONS };
  if (testCase.judgment === 2) {
    const questions = { ...JUDGMENT_2_BASE_QUESTIONS };
    const named = testCase.state?.constraints?.stores_named ?? [];
    for (const store of named) {
      questions[`has_result_${storeSlug(store)}`] = {
        type: "noul",
        instructions: `Is there a result from ${store}?`,
        criteria: {
          true: `at least one result comes from ${store}`,
          false: `no result comes from ${store}`,
        },
      };
    }
    return questions;
  }
  throw new Error(`case ${testCase.id} has an unknown judgment: ${testCase.judgment}`);
}

// ---------------------------------------------------------------------------
// Transport. Retries 429 and 529 with exponential backoff plus jitter.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function askJev(state, questions) {
  const body = JSON.stringify({ state, model: MODEL, questions });
  let attempts = 0;
  let lastError = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (networkError) {
      lastError = { status: 0, detail: String(networkError?.message ?? networkError) };
      await sleep(BASE_BACKOFF_MS * 2 ** (attempts - 1) + Math.floor(Math.random() * 250));
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    if (response.ok) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, attempts, latencyMs, error: { status: response.status, detail: "response was not JSON" } };
      }
      return { ok: true, attempts, latencyMs, response: parsed };
    }

    if (response.status === 401) {
      console.error("TypeSafe rejected the key with 401. Check TYPESAFE_API_KEY and try again.");
      process.exit(1);
    }

    if (response.status === 429 || response.status === 529) {
      lastError = { status: response.status, detail: truncate(text) };
      await sleep(BASE_BACKOFF_MS * 2 ** (attempts - 1) + Math.floor(Math.random() * 250));
      continue;
    }

    return { ok: false, attempts, latencyMs, error: { status: response.status, detail: truncate(text) } };
  }

  return { ok: false, attempts, latencyMs: 0, error: lastError ?? { status: 0, detail: "exhausted retries" } };
}

function truncate(text, max = 600) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat;
}

// ---------------------------------------------------------------------------
// Grading.
// ---------------------------------------------------------------------------

// Only keys present in expected are graded. A case that omits a has_result_<store> label still gets
// that noul asked, because the question set comes from the state, and the answer simply goes
// ungraded. cheapest_rung is a labelled outcome of the rung nouls, not a question, so it is skipped.
function gradeCase(testCase, answers) {
  const grades = [];
  for (const [questionId, expected] of Object.entries(testCase.expected ?? {})) {
    if (questionId === "cheapest_rung" || questionId === "required" || questionId === "fetch") continue;
    const answer = answers?.[questionId];
    if (!answer) {
      grades.push({
        case_id: testCase.id,
        judgment: testCase.judgment,
        question: questionId,
        kind: typeof expected === "boolean" ? "noul" : "choice",
        expected,
        got: null,
        confidence: null,
        correct: false,
        detail: "no answer came back under this id",
      });
      continue;
    }

    if (answer.type === "noul") {
      const confidence = Math.max(answer.noul, 1 - answer.noul);
      const got = answer.noul >= 0.5;
      grades.push({
        case_id: testCase.id,
        judgment: testCase.judgment,
        question: questionId,
        kind: "noul",
        expected,
        got,
        raw: answer.noul,
        confidence,
        correct: got === expected,
      });
      continue;
    }

    if (answer.type === "choice") {
      grades.push({
        case_id: testCase.id,
        judgment: testCase.judgment,
        question: questionId,
        kind: "choice",
        expected,
        got: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        correct: answer.choice === expected,
      });
      continue;
    }

    grades.push({
      case_id: testCase.id,
      judgment: testCase.judgment,
      question: questionId,
      kind: answer.type ?? "unknown",
      expected,
      got: null,
      confidence: null,
      correct: false,
      detail: `unexpected answer type ${answer.type}`,
    });
  }
  return grades;
}

const BUCKETS = [
  { label: "below 0.50", lo: 0, hi: 0.5 },
  { label: "0.50 to 0.70", lo: 0.5, hi: 0.7 },
  { label: "0.70 to 0.90", lo: 0.7, hi: 0.9 },
  { label: "0.90 to 1.00", lo: 0.9, hi: 1.0000001 },
];

function bucketFor(confidence) {
  if (confidence === null || confidence === undefined) return null;
  return BUCKETS.find((b) => confidence >= b.lo && confidence < b.hi) ?? BUCKETS[BUCKETS.length - 1];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function pct(correct, total) {
  if (total === 0) return "n/a";
  return `${((correct / total) * 100).toFixed(1)}%`;
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(text, width) {
  const s = String(text);
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

// A case file is either {cases: [...]} with its own metadata, or a bare array of cases.
const loaded = JSON.parse(readFileSync(CASES_PATH, "utf8"));
const fixture = Array.isArray(loaded) ? { cases: loaded } : loaded;
if (!Array.isArray(fixture.cases)) {
  console.error(`${CASES_PATH} carries no cases array.`);
  process.exit(1);
}
const cases = fixture.cases.filter((c) => (only ? c.id.includes(only) : true));
if (cases.length === 0) {
  console.error("No cases matched. Check the --only filter.");
  process.exit(1);
}

const records = new Array(cases.length);
let nextIndex = 0;

async function worker() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= cases.length) return;
    const testCase = cases[index];
    const questions = questionsFor(testCase);
    const outcome = await askJev(testCase.state, questions);

    const record = {
      id: testCase.id,
      judgment: testCase.judgment,
      note: testCase.note,
      request: { state: testCase.state, model: MODEL, questions },
      expected: testCase.expected,
      attempts: outcome.attempts,
      latency_ms: outcome.latencyMs,
      ok: outcome.ok,
    };

    if (outcome.ok) {
      record.model = outcome.response.model;
      record.answers = outcome.response.answers;
      record.usage = outcome.response.usage;
      record.grades = gradeCase(testCase, outcome.response.answers);
      if (testCase.judgment === 2) {
        // A case may carry the labelled cheapest rung inside expected or beside it.
        const labelled = testCase.expected?.cheapest_rung ?? testCase.cheapest_rung;
        record.code_picked_rung = pickRung(outcome.response.answers);
        if (labelled !== undefined) {
          record.cheapest_rung = labelled;
          record.rung_pick_correct = record.code_picked_rung === labelled;
        }
      }
      if (testCase.judgment === "2b") {
        const required = requiredConfirmations(testCase.state?.constraints);
        const decision = decideFetch(outcome.response.answers, required);
        const labelledRequired = testCase.expected?.required;
        record.confirmation = {
          required_derived: required,
          required_labelled: labelledRequired,
          required_matches_label:
            labelledRequired === undefined ? null : [...required].sort().join() === [...labelledRequired].sort().join(),
          unconfirmed: decision.unconfirmed,
          fetch_decided: decision.fetch,
          fetch_labelled: testCase.expected?.fetch,
          fetch_correct: testCase.expected?.fetch === undefined ? null : decision.fetch === testCase.expected.fetch,
        };
      }
      if (testCase.judgment === 3 && testCase.expected?.is_universal_negative === true) {
        const support = outcome.response.answers.support;
        const downgraded = support.choice === "supports" && support.confidence < UNIVERSAL_NEGATIVE_FLOOR;
        record.universal_negative = {
          support_choice: support.choice,
          support_confidence: support.confidence,
          effective_support: downgraded ? "no_evidence" : support.choice,
          code_rule_fired: downgraded,
        };
      }
    } else {
      record.error = outcome.error;
      record.grades = [];
    }

    records[index] = record;
    process.stderr.write(outcome.ok ? "." : "x");
  }
}

const startedAt = new Date();
await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, cases.length)) }, worker));
const finishedAt = new Date();
process.stderr.write("\n");

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const allGrades = records.flatMap((r) => r.grades ?? []);
const failedCalls = records.filter((r) => !r.ok);
const latencies = records.filter((r) => r.ok).map((r) => r.latency_ms).sort((a, b) => a - b);
const inputTokens = records.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0);
const outputTokens = records.reduce((sum, r) => sum + (r.usage?.output_tokens ?? 0), 0);
const modelIds = [...new Set(records.filter((r) => r.model).map((r) => r.model))];
const cost = (inputTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS;

const perQuestion = new Map();
for (const grade of allGrades) {
  const key = grade.question.startsWith("has_result_")
    ? `j${grade.judgment}.has_result_<store>`
    : `j${grade.judgment}.${grade.question}`;
  const row = perQuestion.get(key) ?? { correct: 0, total: 0 };
  row.total += 1;
  if (grade.correct) row.correct += 1;
  perQuestion.set(key, row);
}

const perBucket = new Map(BUCKETS.map((b) => [b.label, { correct: 0, total: 0 }]));
let unbucketed = 0;
for (const grade of allGrades) {
  const bucket = bucketFor(grade.confidence);
  if (!bucket) {
    unbucketed += 1;
    continue;
  }
  const row = perBucket.get(bucket.label);
  row.total += 1;
  if (grade.correct) row.correct += 1;
}

const perJudgment = new Map();
for (const grade of allGrades) {
  const row = perJudgment.get(grade.judgment) ?? { correct: 0, total: 0 };
  row.total += 1;
  if (grade.correct) row.correct += 1;
  perJudgment.set(grade.judgment, row);
}

const correctTotal = allGrades.filter((g) => g.correct).length;
const lines = [];
lines.push(`Jev eval, JEV-1 offline harness, ${SET_LABEL}`);
lines.push(`cases ${records.length}, answers graded ${allGrades.length}, failed calls ${failedCalls.length}`);
lines.push(`model requested ${MODEL}, model that answered ${modelIds.join(", ") || "none"}`);
lines.push(`run started ${startedAt.toISOString()}, finished ${finishedAt.toISOString()}`);
lines.push("");
lines.push(`overall accuracy ${pct(correctTotal, allGrades.length)}  (${correctTotal} of ${allGrades.length})`);
lines.push("");

lines.push("accuracy per judgment");
for (const judgment of [...perJudgment.keys()].sort()) {
  const row = perJudgment.get(judgment);
  lines.push(`  judgment ${judgment}  ${padLeft(pct(row.correct, row.total), 7)}  (${row.correct} of ${row.total})`);
}
lines.push("");

lines.push("accuracy per question");
for (const key of [...perQuestion.keys()].sort()) {
  const row = perQuestion.get(key);
  lines.push(`  ${pad(key, 28)} ${padLeft(pct(row.correct, row.total), 7)}  (${row.correct} of ${row.total})`);
}
lines.push("");

// Criteria wording changed since a previous run. These move no labels, so the before figure is
// the same question's accuracy in the last run under the old wording, recorded here.
const WORDING_CHANGES = [
  {
    question_key: "j2.satisfies",
    what: 'criterion "no"',
    old: "no result shows the item in any stated pack size",
    new: "a result clearly shows the item and it is not in any stated pack size",
    previous_accuracy: "70.0% (7 of 10) on the tuned set",
    why: "the old wording was also true of a snippet that said nothing, so it overlapped cannot_tell",
  },
];

const corrections = fixture.label_corrections ?? [];
if (corrections.length > 0 || WORDING_CHANGES.length > 0) {
  lines.push("label corrections and wording changes (a wording change moves no labels)");
  lines.push(`  ${pad("case", 24)} ${pad("question", 10)} ${pad("old label", 16)} ${pad("new label", 16)} before   after`);
  for (const correction of corrections) {
    const key = `j1.${correction.question}`;
    const sameQuestion = allGrades.filter((g) => `j${g.judgment}.${g.question}` === key);
    const after = sameQuestion.filter((g) => g.correct).length;
    const before = sameQuestion.filter((g) =>
      g.case_id === correction.case_id ? g.got === correction.old : g.correct,
    ).length;
    lines.push(
      `  ${pad(correction.case_id, 24)} ${pad(correction.question, 10)} ${pad(correction.old, 16)} ${pad(correction.new, 16)} ${padLeft(pct(before, sameQuestion.length), 7)}  ${padLeft(pct(after, sameQuestion.length), 7)}`,
    );
  }
  for (const change of WORDING_CHANGES) {
    const grades = allGrades.filter((g) => `j${g.judgment}.${g.question}` === change.question_key);
    const after = grades.filter((g) => g.correct).length;
    lines.push(`  wording change, no label moved: ${change.question_key} ${change.what}`);
    lines.push(`    was  "${change.old}"`);
    lines.push(`    now  "${change.new}"`);
    lines.push(`    why  ${change.why}`);
    lines.push(
      `    ${change.question_key} accuracy: ${change.previous_accuracy} under the old wording, ${pct(after, grades.length)} (${after} of ${grades.length}) now`,
    );
  }
  lines.push("");
}

const confirmationCases = records.filter((r) => r.ok && r.confirmation);
const scoredConfirmations = confirmationCases.filter((r) => r.confirmation.fetch_correct !== null);
const fetchCorrect = scoredConfirmations.filter((r) => r.confirmation.fetch_correct).length;
if (confirmationCases.length > 0) {
  lines.push("judgment 2b, constraint confirmation (one result per case, fetch decided in code)");
  for (const question of Object.keys(JUDGMENT_2B_QUESTIONS)) {
    const grades = allGrades.filter((g) => g.judgment === "2b" && g.question === question);
    const correct = grades.filter((g) => g.correct).length;
    lines.push(`  ${pad(question, 30)} ${padLeft(pct(correct, grades.length), 7)}  (${correct} of ${grades.length})`);
  }
  lines.push(`  code fetch decision against the fetch label, floor ${CONFIRMATION_FLOOR}:  ${pct(fetchCorrect, scoredConfirmations.length)}  (${fetchCorrect} of ${scoredConfirmations.length})`);
  for (const record of scoredConfirmations.filter((r) => !r.confirmation.fetch_correct)) {
    const c = record.confirmation;
    lines.push(`    ${pad(record.id, 30)} labelled fetch ${pad(String(c.fetch_labelled), 6)} decided ${pad(String(c.fetch_decided), 6)} unconfirmed: ${c.unconfirmed.join(", ") || "none"}`);
  }
  const mismatched = confirmationCases.filter((r) => r.confirmation.required_matches_label === false);
  lines.push(
    `  required set derived from the constraints matches the label on ${confirmationCases.length - mismatched.length} of ${confirmationCases.length} cases${mismatched.length ? `: ${mismatched.map((r) => r.id).join(", ")}` : ""}`,
  );
  lines.push("");
}

const rungCases = records.filter((r) => r.judgment === 2 && r.ok);
const labelledRungCases = rungCases.filter((r) => r.cheapest_rung !== undefined);
if (rungCases.length > 0) {
  lines.push("judgment 2 rungs (one noul each, Jev never orders them)");
  for (const { questions, rung } of RUNG_ORDER) {
    for (const question of questions) {
      const grades = allGrades.filter((g) => g.judgment === 2 && g.question === question);
      const correct = grades.filter((g) => g.correct).length;
      lines.push(`  ${pad(question, 22)} ${pad(`(${rung})`, 22)} ${padLeft(pct(correct, grades.length), 7)}  (${correct} of ${grades.length})`);
    }
  }
  lines.push("  answer_now is picked when either of its two nouls clears the floor");
  for (const note of fixture.rung_label_notes ?? []) lines.push(`  ${note}`);
  const picked = labelledRungCases.filter((r) => r.rung_pick_correct).length;
  lines.push(`  code-picked rung against the labelled cheapest rung, floor ${RUNG_FLOOR}:  ${pct(picked, labelledRungCases.length)}  (${picked} of ${labelledRungCases.length})`);
  if (scoredConfirmations.length > 0) {
    lines.push(`  judgment 2b fetch decision, same floor ${CONFIRMATION_FLOOR}:  ${pct(fetchCorrect, scoredConfirmations.length)}  (${fetchCorrect} of ${scoredConfirmations.length})`);
  }
  const wrongPicks = labelledRungCases.filter((r) => !r.rung_pick_correct);
  for (const record of wrongPicks) {
    lines.push(`    ${pad(record.id, 30)} labelled ${pad(record.cheapest_rung, 20)} picked ${record.code_picked_rung}`);
  }
  lines.push("");
}

const slice = records.filter((r) => r.ok && r.universal_negative);
if (slice.length > 0) {
  const sliceGrades = (question) => {
    const grades = allGrades.filter((g) => g.question === question && slice.some((r) => r.id === g.case_id));
    return { correct: grades.filter((g) => g.correct).length, total: grades.length };
  };
  const support = sliceGrades("support");
  const universal = sliceGrades("is_universal_negative");
  const labelOf = (id) => fixture.cases.find((c) => c.id === id).expected.support;
  const caught = slice.filter((r) => labelOf(r.id) !== "supports" && r.universal_negative.code_rule_fired);
  const missed = slice.filter(
    (r) => labelOf(r.id) !== "supports" && r.universal_negative.support_choice === "supports" && !r.universal_negative.code_rule_fired,
  );
  const overCaught = slice.filter((r) => labelOf(r.id) === "supports" && r.universal_negative.code_rule_fired);
  lines.push("universal-negative slice (every judgment 3 case labelled is_universal_negative true)");
  lines.push(`  cases ${slice.length}, labelled supports ${slice.filter((r) => labelOf(r.id) === "supports").length}, no_evidence ${slice.filter((r) => labelOf(r.id) === "no_evidence").length}, contradicts ${slice.filter((r) => labelOf(r.id) === "contradicts").length}`);
  lines.push(`  support accuracy               ${padLeft(pct(support.correct, support.total), 7)}  (${support.correct} of ${support.total})`);
  lines.push(`  is_universal_negative accuracy ${padLeft(pct(universal.correct, universal.total), 7)}  (${universal.correct} of ${universal.total})`);
  lines.push(`  code rule: support "supports" below ${UNIVERSAL_NEGATIVE_FLOOR} confidence reads as no_evidence`);
  lines.push(`    caught      ${padLeft(caught.length, 2)}  unsupported universal negatives the rule neutralises`);
  lines.push(`    missed      ${padLeft(missed.length, 2)}  unsupported universal negatives it lets through${missed.length ? `: ${missed.map((r) => r.id).join(", ")}` : ""}`);
  lines.push(`    over-caught ${padLeft(overCaught.length, 2)}  genuinely supported universal negatives it wrongly downgrades${overCaught.length ? `: ${overCaught.map((r) => r.id).join(", ")}` : ""}`);
  lines.push("");
}

lines.push("accuracy by confidence bucket (nouls use max(noul, 1 minus noul))");
for (const bucket of BUCKETS) {
  const row = perBucket.get(bucket.label);
  lines.push(`  ${pad(bucket.label, 14)} n=${padLeft(row.total, 3)}  ${padLeft(pct(row.correct, row.total), 7)}  (${row.correct} of ${row.total})`);
}
if (unbucketed > 0) lines.push(`  no confidence  n=${padLeft(unbucketed, 3)}  (answers that never came back)`);
lines.push("");

lines.push("latency and cost");
lines.push(`  p50 ${percentile(latencies, 0.5)} ms, p95 ${percentile(latencies, 0.95)} ms over ${latencies.length} calls`);
lines.push(`  input tokens ${inputTokens}, output tokens ${outputTokens}`);
lines.push(`  cost at $${USD_PER_MILLION_INPUT_TOKENS} per million input tokens: $${cost.toFixed(6)}`);
lines.push("");

const misses = allGrades.filter((g) => !g.correct);
lines.push(`misses (${misses.length})`);
if (misses.length === 0) {
  lines.push("  none");
} else {
  lines.push(`  ${pad("case", 30)} ${pad("question", 24)} ${pad("expected", 20)} ${pad("got", 20)} conf`);
  for (const miss of misses) {
    const confidence = miss.confidence === null || miss.confidence === undefined ? "n/a" : miss.confidence.toFixed(2);
    const raw = miss.kind === "noul" && miss.raw !== undefined ? ` (noul ${miss.raw.toFixed(2)})` : "";
    lines.push(
      `  ${pad(miss.case_id, 30)} ${pad(miss.question, 24)} ${pad(String(miss.expected), 20)} ${pad(String(miss.got) + raw, 20)} ${confidence}`,
    );
  }
}

if (failedCalls.length > 0) {
  lines.push("");
  lines.push("failed calls");
  for (const record of failedCalls) {
    lines.push(`  ${record.id}: ${record.error?.status} ${record.error?.detail}`);
  }
}

const report = lines.join("\n");
console.log(report);

writeFileSync(
  OUT_PATH,
  `${JSON.stringify(
    {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      endpoint: ENDPOINT,
      model_requested: MODEL,
      model_ids: modelIds,
      price_usd_per_million_input_tokens: USD_PER_MILLION_INPUT_TOKENS,
      totals: {
        cases: records.length,
        graded: allGrades.length,
        correct: correctTotal,
        failed_calls: failedCalls.length,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: Number(cost.toFixed(6)),
        latency_p50_ms: percentile(latencies, 0.5),
        latency_p95_ms: percentile(latencies, 0.95),
      },
      report_text: report,
      cases: records,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log("");
console.log(`raw output written to ${OUT_PATH}`);
