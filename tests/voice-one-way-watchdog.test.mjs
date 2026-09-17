// VOICE-21. A call where the person's voice reaches nobody says so, once.
//
// THE CALL THIS EXISTS FOR, measured on the R750. A session took 148 seconds of the operator's
// speech at a peak of -2.6 dBFS, the provider emitted no speech_started, no transcript and no
// failure, and zero turns reached the agent. Titan answered normally the whole time, so from where
// the person stood the call was working and nothing on the screen said otherwise. Problem reports
// 24 and 36 are both that call: "one-way audio, agent to operator works, operator to agent silently
// dropped with no error shown to the user".
//
// The rule is a pure function so it can be driven here with no socket, no vendor and no clock. What
// the relay adds around it is a byte counter and four reset points; the counter's arithmetic is the
// relay's own bytesToSeconds, which is why these cases are written in seconds.
import assert from "node:assert/strict";
import test from "node:test";

import { ONE_WAY_SECONDS, ONE_WAY_SENTENCE, oneWayCallVerdict } from "../ui/voice-edge.mjs";

test("it fires once the audio passes the threshold with nothing heard", () => {
  const verdict = oneWayCallVerdict({ secondsSinceHeard: ONE_WAY_SECONDS, heard: false, alreadyFired: false });
  assert.equal(verdict.fire, true);
  assert.match(verdict.why, /nothing heard by the provider/);
  // The threshold is a boundary, not a range: one second short is silence, not a warning.
  assert.equal(oneWayCallVerdict({ secondsSinceHeard: ONE_WAY_SECONDS - 1 }).fire, false);
  assert.equal(oneWayCallVerdict({ secondsSinceHeard: 148 }).fire, true, "the R750 call would have been caught");
});

test("it does not fire when the provider heard something early in the call", () => {
  // The five-second case: a normal call where the first transcript arrives quickly. The relay zeroes
  // the counter on speech_started and on every transcription event, so by twenty seconds of audio
  // there are only fifteen seconds since the last thing that was heard.
  assert.equal(oneWayCallVerdict({ secondsSinceHeard: 15, heard: false }).fire, false);
  // And `heard` alone settles it whatever the count says, which is the guard for a vendor that
  // sends a transcript without a speech_started.
  assert.equal(oneWayCallVerdict({ secondsSinceHeard: 600, heard: true }).fire, false);
  assert.match(oneWayCallVerdict({ secondsSinceHeard: 600, heard: true }).why, /heard something/);
});

test("it fires at most once per line", () => {
  assert.equal(oneWayCallVerdict({ secondsSinceHeard: 60, alreadyFired: true }).fire, false);
  assert.match(oneWayCallVerdict({ secondsSinceHeard: 60, alreadyFired: true }).why, /already been told/);
  // A line that has been told once and then starts working clears the chip, which is the reset
  // below rather than a second fire.
  assert.equal(oneWayCallVerdict({ secondsSinceHeard: 0, alreadyFired: false, heard: false }).fire, false);
});

test("an agent turn resets the count, so a call that stops working is caught too", () => {
  // The relay restarts the counter whenever a turn reaches the agent, so the watch is against the
  // last thing that worked rather than against the start of the call. Modelled here the way the
  // relay does it: the count goes back to zero, and the next twenty seconds arm it again.
  let secondsSinceHeard = 45;
  assert.equal(oneWayCallVerdict({ secondsSinceHeard }).fire, true, "armed before the turn");
  secondsSinceHeard = 0;
  assert.equal(oneWayCallVerdict({ secondsSinceHeard }).fire, false, "a turn reached the agent");
  secondsSinceHeard = ONE_WAY_SECONDS;
  assert.equal(oneWayCallVerdict({ secondsSinceHeard }).fire, true, "and it arms again if the line goes quiet after");
});

test("the words are the person's, with no prefix and no underline", () => {
  // Jason reads a prefixed underlined line as a failure (host-notes-read-as-errors). This is a fact
  // about the microphone, not a broken call: Titan is still answering.
  assert.equal(ONE_WAY_SENTENCE, "Your voice is not reaching Titan. Check the microphone, or hang up and call again.");
  assert.ok(!/^[A-Za-z ]+:/.test(ONE_WAY_SENTENCE), "no prefix");
  assert.ok(!/[_*`]/.test(ONE_WAY_SENTENCE), "no underline or markup");
  assert.ok(!/[—–]/.test(ONE_WAY_SENTENCE), "no em dash");
  assert.ok(ONE_WAY_SENTENCE.includes("Check the microphone"), "it says what to do next");
});

test("the relay wires the rule to the frame it forwards, and clears it on every heard event", async () => {
  // The rule being right is half of it; the other half is that something calls it. Asserted on the
  // source, because the session closure is not reachable from here without a socket and a vendor.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(repoRoot, "ui/voice-edge.mjs"), "utf8");
  assert.match(source, /oneWay\.bytesSinceHeard \+= payload\.byteLength;\s*\n\s*noteOneWayAudio\(\);/,
    "the count and the check ride on the frame that is actually forwarded");
  // Four resets: the two vendors disagree on which event comes first, and an agent turn proves the
  // whole path works whatever the provider said earlier.
  assert.equal((source.match(/heardSomething\(\);/g) ?? []).length, 5,
    "speech_started, transcription updated/delta, completed, failed, and an agent turn");
  assert.match(source, /browser\?\.sendJson\(\{ t: "one-way", text: ONE_WAY_SENTENCE \}\)/);
  assert.match(source, /browser\?\.sendJson\(\{ t: "one-way", text: "" \}\)/, "an empty text clears the chip");
  assert.match(source, /voice one-way call: \$\{bytesToSeconds\(oneWay\.bytesSinceHeard\)\} s of audio in, nothing heard by the provider/);
});

test("the provider's whole error object reaches the log, capped", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(repoRoot, "ui/voice-edge.mjs"), "utf8");
  // Seven of these were logged on the R750 as a bare code while the operator's voice reached nobody.
  assert.match(source, /the provider said \$\{JSON\.stringify\(event\?\.error \?\? \{\}\)\.slice\(0, 2_000\)\}/,
    "the whole object, one line, capped at 2,000 characters");
  assert.match(source, /voice note from the provider: \$\{event\?\.error\?\.code\}/, "and the code is still there");
});

test("the call screen draws it as a chip and clears it on an empty text", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const page = readFileSync(path.join(repoRoot, "ui/machine-room/voice.js"), "utf8");
  assert.match(page, /case "one-way":/);
  assert.match(page, /function renderOneWayChip\(text\)/);
  assert.match(page, /if \(words\.length === 0\) \{\s*\n\s*if \(chip != null\) hide\(chip, true\);/,
    "an empty text hides the chip rather than drawing an empty one");
  // It is not a note, so it cannot colour the orb or open an expander.
  const at = page.indexOf('case "one-way":');
  const branch = page.slice(at, page.indexOf("break;", at));
  assert.ok(!branch.includes("note("), "the one-way frame never goes through the note path");
});
