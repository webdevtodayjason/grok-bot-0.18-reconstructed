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

const prompt = (localMachineConnected) =>
  mod.buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, localMachineConnected });

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

// The per-turn attached-files note is prompt text too, and it names two of the five. It is built
// from the desktop app's attachment paths, so the two facts usually agree -- but an app that
// attaches a file and then drops its local-exec stream makes them disagree, and then the note was
// telling the model to ExternalRead a file with no ExternalRead.
test("the attached-files note stops naming ExternalRead when no computer is connected", () => {
  const files = ["/Users/x/report.pdf"];
  const staged = new Map([["/Users/x/report.pdf", "/workspace/uploads/report.pdf"]]);
  const connected = mod.buildAttachedFilesNote(files, staged, new Map(), true);
  assert.ok(connected.includes("ExternalRead"), "the connected wording is unchanged");
  const withheld = mod.buildAttachedFilesNote(files, staged, new Map(), false);
  assert.ok(!withheld.includes("ExternalRead"), "no ExternalRead in the withheld wording");
  assert.ok(withheld.includes("/workspace/uploads/report.pdf"), "the box path it CAN read is still there");
  const unstaged = mod.buildAttachedFilesNote(files, new Map(), new Map(), false);
  for (const name of ["ExternalRead", "CopyToBox"]) {
    assert.ok(!unstaged.includes(name), `${name} is not offered as a way to open the file`);
  }
  assert.ok(unstaged.includes("paste the contents"), "it says what the model should do instead");
});

test("a caller with no view of the bridge keeps the wording it always had", () => {
  const note = mod.buildAttachedFilesNote(["/Users/x/a.txt"]);
  assert.ok(note.includes("ExternalRead"), "the default is the connected wording");
});
