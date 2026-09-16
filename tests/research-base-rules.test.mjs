// BASELINE-1, pieces 3 and 4, measured on the rendered base prompt.
//
// THE FAULT THESE EXIST FOR. The four failures the Kelley bolt case exposed are all failures of a
// CONFIDENT answer: a retailer's own search box read as that retailer's catalog, "nobody carries
// it" written off one empty result, a national price answering a local question, and a shop the
// person named dropped without a word. A skill file catches them only on a turn that opens the
// skill file. Measured on the R750 2026-09-15, seven of ten tenant boxes carried no web search at
// all and no research recipe anywhere, so the layer below skills is where the four have to hold.
//
// And the escalation ladder only ever knew about HARD failure: a refusal, an error, an empty
// result. A lookup that works perfectly and comes back with the wrong thing is where nearly every
// bad answer comes from, and it looks identical to success, so the ladder now names it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".research-base-rules-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const require_ = createRequire(import.meta.url);
const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
};
const mod = await bundle("source/host/runner/system-prompt.ts", "system-prompt.cjs");
const persona = await bundle("source/host/runner/standing-persona.ts", "standing-persona.cjs");
const prompt = (localMachineConnected) => mod.buildSandBaseSystemPrompt({ localMachineConnected });

/** The section, on its own, from either variant of the prompt. */
function lookupSection(text) {
  const at = text.indexOf("## Looking something up");
  assert.ok(at > 0, "the base prompt carries the section");
  const next = text.indexOf("\n## ", at + 4);
  return text.slice(at, next === -1 ? text.length : next).trim();
}

/** The one bullet that teaches the escalation order. */
function ladderBullet(text) {
  const line = text.split("\n").find((one) => one.includes("escalate in order, cheapest and most reliable first"));
  assert.ok(line != null, "the escalation ladder is still one bullet in this prompt");
  return line;
}

// ------------------------------------------------------------------ piece 3: the four rules

test("the four rules are in the base prompt, whichever machines are connected", () => {
  for (const connected of [true, false]) {
    const section = lookupSection(prompt(connected));
    assert.match(section, /is not that site's catalog/, `R1 with localMachineConnected ${connected}`);
    assert.match(section, /Never write a universal negative/, `R2 with localMachineConnected ${connected}`);
    assert.match(section, /Answer at the height the question was asked/, `R4 with localMachineConnected ${connected}`);
    assert.match(section, /Every source the person named appears in your answer/, `R5 with localMachineConnected ${connected}`);
  }
});

test("it is four sentences and no more, because the budget is the point", (t) => {
  const section = lookupSection(prompt(true));
  const sentences = section.split("\n").slice(1).filter((line) => line.trim().length > 0);
  t.diagnostic(`the section is ${section.length} characters over ${sentences.length} sentences`);
  assert.equal(sentences.length, 4, `the reasoning and the worked example stay in the skill:\n${section}`);
  for (const sentence of sentences) {
    // One sentence each, so the four cannot quietly become eight. A quoted phrase ending in a full
    // stop inside the line is not a sentence break, so only a stop followed by a space counts.
    const stops = [...sentence.matchAll(/[.?!]\s+(?=[A-Z"'(])/g)].length;
    assert.equal(stops, 0, `one sentence, not several: ${JSON.stringify(sentence.slice(0, 120))}`);
  }
  // Paid once on every turn of every agent on every box, so it is measured rather than assumed.
  assert.ok(section.length < 1_100, `${section.length} characters is more standing prompt than four rules need`);
});

test("each rule forbids the thing the bad run did, not just names the topic", () => {
  const section = lookupSection(prompt(true));
  // R1: the search box is evidence about the search box.
  assert.match(section, /evidence about the search box/);
  assert.match(section, /never as "they don't have it"/);
  // R2: the strongest form is the first person, and it needs the general index too.
  assert.match(section, /every named source exhausted and a plain web search against each/);
  assert.match(section, /strongest form you may use is that you couldn't find it/);
  // R4: the two altitudes the case turned on.
  assert.match(section, /named places and what each one has rather than to one national price/);
  assert.match(section, /"who sells it" resolves to sellers rather than to a price/);
  // R5: including the source that came back with nothing.
  assert.match(section, /including as checked and nothing found/);
  assert.match(section, /reads as "not there" and you never established that/);
});

test("the rules are in the base prompt and not in the standing persona section", () => {
  // standing-persona.ts is composed fresh on every turn out of live, box-local reads. These four
  // are the same on every box forever, so putting them there would buy nothing and be paid per turn.
  // This case fails the day somebody moves them, which is the only way the cost changes silently.
  const base = prompt(true);
  assert.ok(base.includes("## Looking something up"), "the base prompt carries them");
  const personaSource = mod.buildSandBaseSystemPrompt.toString();
  assert.ok(personaSource.length > 0);
  assert.equal(typeof persona.renderStandingPersonaSection, "function",
    "the persona module still exports the section builder this case is about");
  const rendered = persona.renderStandingPersonaSection({ agentId: null, agents: [] });
  assert.equal(rendered, null, "a runner with no agent identity renders no persona section at all");
});

test("the rules say nothing that needs a skill file open to be true", () => {
  const section = lookupSection(prompt(true));
  // A rule pointing at a path is a rule that fails on the box the wave exists for: one whose
  // managed seeds never materialized their files.
  assert.ok(!/SKILL\.md|managed-skills|agent-data/.test(section), "no path in the four sentences");
  assert.ok(!/research/i.test(section), "and no dependency on the skill by name");
});

// ------------------------------------------------------------------ piece 4: the ladder

test("the ladder escalates on a soft failure as well as a hard one", () => {
  for (const connected of [true, false]) {
    const bullet = ladderBullet(prompt(connected));
    assert.match(bullet, /A rung that answered without answering THE QUESTION is a failure too/,
      `the soft failure is named with localMachineConnected ${connected}`);
    assert.match(bullet, /the qualifier, the place, or the thing that would make you done/,
      "and the three parsed slots that decide whether a result matches");
    assert.match(bullet, /escalate exactly as you would on a refusal or an error/,
      "with the same escalation a hard failure earns");
    assert.match(bullet, /looks identical to success/,
      "and the reason it is missed, which is the whole of why it is worth prompt bytes");
  }
});

test("the cheapest escalation is a better query, and it comes before a bigger tool", () => {
  const bullet = ladderBullet(prompt(true));
  assert.match(bullet, /cheapest escalation is almost never a bigger tool/);
  assert.match(bullet, /re-run the rung you are on with a better query first/);
  for (const kind of ["spellings and units", "trade's own word", "scoped to the site"]) {
    assert.ok(bullet.includes(kind), `the better query is spelled out: ${kind}`);
  }
  assert.match(bullet, /climb only once that has been tried/);
  // Order matters: the new sentences ride at the END of the ladder bullet, after the six rungs and
  // after the do-not-blast-down rule, so nothing was inserted into the middle of the numbered list.
  const rungSix = bullet.indexOf("(6) hand the step back to the user");
  assert.ok(rungSix > 0 && bullet.indexOf("A rung that answered") > rungSix,
    "the amendment is after the six rungs, not spliced into them");
});

test("nothing added here carries an em dash", () => {
  const added = [lookupSection(prompt(true)), ladderBullet(prompt(true)).slice(ladderBullet(prompt(true)).indexOf("A rung that answered"))];
  for (const text of added) {
    assert.ok(!/[—–]/.test(text), `an em dash in ${JSON.stringify(text.slice(0, 80))}`);
  }
});
