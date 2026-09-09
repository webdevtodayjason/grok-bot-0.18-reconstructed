// The prompt half of the local-machine withhold, measured on the rendered text.
//
// TOOLS-15. Five tools reach the operator's own computer over the local-exec bridge, and the turn
// toolset withholds them when nothing answers there. The base prompt teaches those five at length,
// so it has to swing on the same fact: a prompt that keeps coaching ExternalShell after the tool
// is gone is the same failure as offering the dead tool, one layer up. Until this suite the only
// check was the integration gate, which needs a running box. These cases render both variants out
// of the tree and assert the withheld one names no tool the model was not handed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".local-machine-prompt-test-"));
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
// The "Your box" section is assembled here, not in the base prompt, and it is where the marker
// the host reports as the `localMachine` prompt section actually lives.
const glue = await bundle("source/host/runner/prompt-collector-glue.ts", "prompt-collector-glue.cjs");
const boxSection = (localMachineConnected) => glue.createPromptCollectorGlue({
  isLocalMachineConnected: () => localMachineConnected,
}).getRemoteBoxSection();

// CURSOR-1 part f dropped `cloudAgentsEnabled` from the options: every branch that swung on it
// coached a tool the same turn's toolset withheld, so there is nothing left for it to select.
const prompt = (localMachineConnected) =>
  mod.buildSandBaseSystemPrompt({ localMachineConnected });

// The marker host-runner-composition.ts reports as the `localMachine` prompt section, so the
// integration gate and this suite are asserting the same string.
const TWO_MACHINES = "Your box and the user's computer are separate machines";

test("the connected prompt still teaches the five, and the box section carries the marker", () => {
  const text = prompt(true);
  for (const name of ["ExternalShell", "ExternalRead"]) {
    assert.ok(text.includes(name), `${name} is described`);
  }
  const section = boxSection(true);
  assert.ok(section.includes(TWO_MACHINES), "the two-machines paragraph is present");
  for (const name of ["ExternalRead", "ExternalShell", "CopyToBox", "CopyFromBox"]) {
    assert.ok(section.includes(name), `${name} is described in the box section`);
  }
});

test("with no computer connected the box section drops the marker and the transfers", () => {
  const section = boxSection(false);
  assert.ok(!section.includes(TWO_MACHINES), "the two-machines paragraph is gone");
  for (const name of ["ExternalRead", "ExternalShell", "CopyToBox", "CopyFromBox"]) {
    assert.ok(!section.includes(name), `${name} is not named in the box section`);
  }
  assert.ok(section.includes("The box is ONE persistent Linux machine"), "the box itself is still described");
});

test("with no computer connected the prompt names no tool the model was not offered", () => {
  const text = prompt(false);
  for (const name of ["AwaitExternalShell", "CopyToBox", "CopyFromBox"]) {
    assert.ok(!text.includes(name), `${name} is not mentioned (it was not offered)`);
  }
  // ExternalShell and ExternalRead survive exactly once each, in the sentence that says the model
  // does NOT have them. Anything above that is a paragraph still coaching a withheld tool.
  for (const name of ["ExternalShell", "ExternalRead"]) {
    assert.equal(text.split(name).length - 1, 1, `${name} appears only in the sentence denying it`);
  }
  assert.ok(text.includes("no computer is connected right now"),
    "the denial says it is a live fact, not a property of the deployment");
});

test("nothing tells the model to move a file onto a machine it cannot reach", () => {
  const text = prompt(false);
  for (const phrase of [
    "copying a video onto their machine",
    "the app copies it onto the host for you automatically",
  ]) {
    assert.ok(!text.includes(phrase), `the withheld prompt drops: ${phrase}`);
  }
});

// ATTACH-1. The per-turn attached-files note used to be part of this suite's subject, because it
// named ExternalRead and CopyToBox and so had to swing with them. It no longer names either: the
// console uploads an attachment into <sandRoot>/agents/<id>/attachments/, which IS this box, so
// the note now points at a path the agent's own Read opens and says nothing about anybody else's
// machine. What it says is asserted in tests/standing-persona.test.mjs, beside the rest of
// PERSONA-1's wording; what belongs here is that the withhold no longer reaches it at all.
test("the attached-files note is about this box, whatever the bridge is doing", () => {
  const files = ["/home/box/sand-data/agents/a/attachments/report.pdf"];
  for (const connected of [true, false]) {
    const note = mod.buildAttachedFilesNote(files, new Map(), new Map(), connected);
    assert.ok(note.includes("on this box"), "the files are on this box");
    for (const name of ["ExternalRead", "CopyToBox", "the user's computer"]) {
      assert.ok(!note.includes(name), `${name} is not named (bridge connected: ${connected})`);
    }
    assert.ok(note.includes(files[0]), "the path it can open is there");
  }
});

test("a staged box path is the one the note names", () => {
  const staged = new Map([["/tmp/incoming/shot.png", "/workspace/uploads/shot.png"]]);
  const note = mod.buildAttachedFilesNote(["/tmp/incoming/shot.png"], staged);
  assert.ok(note.includes("/workspace/uploads/shot.png"), "the staged path wins");
});
