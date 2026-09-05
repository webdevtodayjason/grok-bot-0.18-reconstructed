// LOOP-1: the counter that stops an agent talking to itself.
//
// Measured on the box before this existed: a stub model that answers every request with one
// SendMessage call drove thirty consecutive steps and thirty-five wire requests in twelve
// seconds, and only stopped because the stub stopped feeding it. These cases pin the rules that
// decide when a streak is a loop: what counts, what clears it, what the setting does, and that
// a legitimate multi-message answer that ends on its own is never cut short.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/runner/self-talk-cap.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"], logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".self-talk-cap-test-"));
const bundlePath = path.join(stage, "self-talk-cap.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
after(() => rmSync(stage, { recursive: true, force: true }));
const mod = createRequire(import.meta.url)(bundlePath);
const {
  createSelfTalkCap,
  resolveSelfTalkCap,
  isSelfTalkStep,
  normalizeSelfTalkResult,
  DEFAULT_SELF_TALK_CAP,
  SAND_SELF_TALK_CAP_SETTING,
  SELF_TALK_CAP_NOTICE,
} = mod;

// The ack the real SendMessage tool renders, with a fresh id every call.
let sent = 0;
const spoke = () => ({ toolNames: ["SendMessage"], resultTexts: [`Message sent to user. (id: t1s${++sent})`] });
const worked = (name = "Shell", result = "ok") => ({ toolNames: [name], resultTexts: [result] });

const capWith = (cap) => {
  const reached = [];
  const counter = createSelfTalkCap({ readCap: () => cap, onCapReached: (verdict) => reached.push(verdict) });
  return { counter, reached };
};

test("the setting name and the default are what an operator was told", () => {
  assert.equal(SAND_SELF_TALK_CAP_SETTING, "SAND_SELF_TALK_CAP");
  assert.equal(DEFAULT_SELF_TALK_CAP, 5);
  assert.match(SELF_TALK_CAP_NOTICE, /nothing new/);
});

test("an unset, blank or unparseable setting falls back to the default rather than to off", () => {
  assert.equal(resolveSelfTalkCap(undefined), 5);
  assert.equal(resolveSelfTalkCap(""), 5);
  assert.equal(resolveSelfTalkCap("   "), 5);
  assert.equal(resolveSelfTalkCap("banana"), 5);
});

test("the setting overrides the default, and 0 or a negative number disables the cap", () => {
  assert.equal(resolveSelfTalkCap("2"), 2);
  assert.equal(resolveSelfTalkCap(" 12 "), 12);
  assert.equal(resolveSelfTalkCap("0"), 0);
  assert.equal(resolveSelfTalkCap("-3"), 0);
});

test("a step is self-talk when SendMessage is the only tool it called", () => {
  assert.equal(isSelfTalkStep({ toolNames: ["SendMessage"], resultTexts: [] }), true);
  assert.equal(isSelfTalkStep({ toolNames: ["SendMessage", "SendMessage"], resultTexts: [] }), true);
  assert.equal(isSelfTalkStep({ toolNames: [], resultTexts: [] }), true);
  assert.equal(isSelfTalkStep({ toolNames: ["SendMessage", "Shell"], resultTexts: [] }), false);
  assert.equal(isSelfTalkStep({ toolNames: ["Shell"], resultTexts: [] }), false);
});

test("the send ack's message id is not new information", () => {
  assert.equal(
    normalizeSelfTalkResult("Message sent to user. (id: t4s9)"),
    normalizeSelfTalkResult("Message sent to user. (id: t7s2)"),
  );
  assert.notEqual(
    normalizeSelfTalkResult("Message sent to user. (id: t4s9)"),
    normalizeSelfTalkResult("Failed to send the message to the user."),
  );
});

test("five SendMessage-only steps end the turn, and the fifth is the one that reports", () => {
  const { counter, reached } = capWith(5);
  const verdicts = [1, 2, 3, 4, 5].map(() => counter.noteStep(spoke()));
  assert.deepEqual(verdicts.map((v) => v.ended), [false, false, false, false, true]);
  assert.deepEqual(verdicts.map((v) => v.steps), [1, 2, 3, 4, 5]);
  assert.equal(reached.length, 1);
  assert.deepEqual(reached[0], { ended: true, steps: 5, cap: 5 });
});

test("a step that ran any other tool clears the streak", () => {
  const { counter, reached } = capWith(3);
  counter.noteStep(spoke());
  counter.noteStep(spoke());
  assert.equal(counter.noteStep(worked()).steps, 0);
  assert.equal(counter.noteStep(spoke()).ended, false);
  assert.equal(counter.noteStep(spoke()).ended, false);
  assert.equal(counter.noteStep(spoke()).ended, true);
  assert.equal(reached.length, 1);
});

test("a step that mixes SendMessage with real work clears the streak too", () => {
  const { counter } = capWith(3);
  counter.noteStep(spoke());
  counter.noteStep(spoke());
  assert.equal(counter.noteStep({ toolNames: ["SendMessage", "Shell"], resultTexts: ["ok"] }).steps, 0);
});

test("a tool result that changed restarts the streak at this step", () => {
  const { counter } = capWith(3);
  counter.noteStep(spoke());
  counter.noteStep(spoke());
  // The send cap refuses the third: a different result, so the agent has learned something.
  const refused = counter.noteStep({ toolNames: ["SendMessage"], resultTexts: ["Failed to send the message to the user: Send cap reached."] });
  assert.deepEqual({ ended: refused.ended, steps: refused.steps }, { ended: false, steps: 1 });
  assert.equal(counter.noteStep({ toolNames: ["SendMessage"], resultTexts: ["Failed to send the message to the user: Send cap reached."] }).steps, 2);
});

test("a legitimate multi-message answer that ends on its own is never cut short", () => {
  const { counter, reached } = capWith(5);
  // Four beats and then the model stops calling tools: nothing here ends the turn early.
  for (const step of [spoke(), spoke(), worked("Read", "file body"), spoke(), spoke()]) {
    assert.equal(counter.noteStep(step).ended, false);
  }
  assert.equal(reached.length, 0);
});

test("a cap of 0 disables the cap however long the streak runs", () => {
  const { counter, reached } = capWith(0);
  for (let index = 0; index < 50; index += 1) {
    const verdict = counter.noteStep(spoke());
    assert.deepEqual({ ended: verdict.ended, cap: verdict.cap }, { ended: false, cap: 0 });
  }
  assert.equal(reached.length, 0);
});

test("a cap of 1 ends the turn on the first SendMessage-only step", () => {
  const { counter, reached } = capWith(1);
  assert.equal(counter.noteStep(spoke()).ended, true);
  assert.equal(reached.length, 1);
});

test("the cap is re-read every step, so raising it on a live box takes effect", () => {
  let cap = 3;
  const reached = [];
  const counter = createSelfTalkCap({ readCap: () => cap, onCapReached: (verdict) => reached.push(verdict) });
  assert.equal(counter.noteStep(spoke()).cap, 3);
  assert.equal(counter.noteStep(spoke()).ended, false);
  cap = 9;
  assert.equal(counter.noteStep(spoke()).ended, false, "the third step no longer trips a cap of 9");
  assert.equal(counter.noteStep(spoke()).steps, 4);
  assert.equal(reached.length, 0);
});

test("turning the cap off mid-streak clears what was counted", () => {
  let cap = 5;
  const { noteStep } = createSelfTalkCap({ readCap: () => cap, onCapReached: () => {} });
  noteStep(spoke());
  noteStep(spoke());
  cap = 0;
  assert.equal(noteStep(spoke()).steps, 0);
  cap = 5;
  assert.equal(noteStep(spoke()).steps, 1);
});

test("the report fires once, not on every step past the cap", () => {
  const { counter, reached } = capWith(2);
  counter.noteStep(spoke());
  counter.noteStep(spoke());
  counter.noteStep(spoke());
  counter.noteStep(spoke());
  assert.equal(reached.length, 1);
});
