// UX-ERR-1. When a turn ends in an error the conversation says so, in words, with no stack.
//
// Jason, 2026-09-07 08:04: "I said something to Titan and it popped up like he was talking, then it
// went away. I don't see any errors." The failure was real (BOX-6) and lived only in the host log.
//
// What this pins is the COPY, because the copy is the whole feature: an error class on the page is
// the same silence wearing a different shirt.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".turn-failed-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/transcript/turn-failed-entry.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
writeFileSync(path.join(stage, "turn-failed-entry.cjs"), result.outputFiles[0].text, "utf8");
const mod = createRequire(import.meta.url)(path.join(stage, "turn-failed-entry.cjs"));

const sqliteCorrupt = Object.assign(new Error("database disk image is malformed"), { code: "ERR_SQLITE_ERROR" });

test("the store failure BOX-6 was about reads as a repair, not as an error code", () => {
  assert.equal(mod.plainWordsForTurnFailure(sqliteCorrupt), "the conversation store needs repair");
});

test("the whole line is one sentence with the agent's name and what to do next", () => {
  const text = mod.turnFailedText("Titan", sqliteCorrupt);
  assert.equal(text, "Titan could not answer this one: the conversation store needs repair. Try again, or open the host log.");
  assert.equal(/ERR_|Error:|\bat \w+ \(/.test(text), false, `the line carries a stack or an error class: ${text}`);
});

test("an agent with no name still gets a sentence rather than an empty one", () => {
  assert.equal(mod.turnFailedText(undefined, sqliteCorrupt).startsWith("This agent could not answer this one:"), true);
  assert.equal(mod.turnFailedText("   ", sqliteCorrupt).startsWith("This agent could not answer this one:"), true);
});

test("an error nobody classified still says something a person can read", () => {
  const text = mod.turnFailedText("Scribe", new Error("Internal error during token generation"));
  assert.equal(text.includes("Internal error during token generation"), false,
    "the provider's own wording leaked onto the page");
  assert.equal(text, "Scribe could not answer this one: something went wrong on the way to an answer. Try again, or open the host log.");
});

test("the entry carries the kind the console filters on, and the cause on its own", () => {
  const entry = mod.buildTurnFailedEntry({ agentName: "Titan", error: sqliteCorrupt, turnId: "turn-9", timestampMs: 1700 });
  assert.equal(entry.kind, "turn-failed");
  assert.equal(entry.cause, "the conversation store needs repair");
  assert.equal(entry.turnId, "turn-9");
  assert.equal(entry.timestampMs, 1700);
  assert.equal(typeof entry.id, "string");
  assert.equal(entry.id.length > 0, true);
  assert.equal("detail" in entry, false, "a detail field is a stack trace waiting to be filled in");
});
