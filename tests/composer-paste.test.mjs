// A paste too big for the composer becomes a file (QOL-COMPOSER). Two things are worth pinning:
// where the threshold sits -- 4,000 characters or 40 lines, either one, not both -- and what the
// file is called, because the extension is a claim about the content. A .md on a log file sends
// the agent looking for structure that is not there, and a .txt on a briefing loses it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Lift the helpers straight out of the shipped file, so the test cannot drift from the console.
async function loadPasteHelpers() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const open = "  // --8<-- QOL-COMPOSER paste helpers";
  const close = "  // --8<-- end QOL-COMPOSER paste helpers";
  const start = source.indexOf(open);
  const end = source.indexOf(close);
  assert.ok(start > 0 && end > start, "the QOL-COMPOSER paste helpers must be findable in app.js");
  const body = source.slice(start, end);
  return new Function(`${body}\nreturn { PASTE_MAX_CHARS, PASTE_MAX_LINES, pasteIsFileSized, looksLikeMarkdown, pastedFileName };`)();
}

const { PASTE_MAX_CHARS, PASTE_MAX_LINES, pasteIsFileSized, looksLikeMarkdown, pastedFileName } = await loadPasteHelpers();

test("the threshold the console ships is 4,000 characters or 40 lines", () => {
  assert.equal(PASTE_MAX_CHARS, 4000);
  assert.equal(PASTE_MAX_LINES, 40);
});

test("an ordinary paste stays in the box", () => {
  assert.equal(pasteIsFileSized(""), false);
  assert.equal(pasteIsFileSized("restart the Atera worker and tell me what it says"), false);
  assert.equal(pasteIsFileSized("x".repeat(PASTE_MAX_CHARS)), false, "the threshold is exclusive at the boundary");
  assert.equal(pasteIsFileSized("line\n".repeat(PASTE_MAX_LINES - 1)), false);
});

test("either limit on its own makes it a file", () => {
  // Long and unbroken: one line, over the character limit.
  assert.equal(pasteIsFileSized("x".repeat(PASTE_MAX_CHARS + 1)), true);
  // Short but tall: well under the character limit, over the line limit. This is the case a
  // character-only threshold missed -- a 41-line stack trace is 900 characters.
  const tall = Array.from({ length: PASTE_MAX_LINES + 1 }, (_, i) => `at frame ${i}`).join("\n");
  assert.ok(tall.length < PASTE_MAX_CHARS, "the tall case must be under the character limit to prove the line limit fires");
  assert.equal(pasteIsFileSized(tall), true);
});

test("a 5,000-character paste is a file (the gate's case)", () => {
  assert.equal(pasteIsFileSized("y".repeat(5000)), true);
});

test("markdown is recognised by any one of its marks", () => {
  assert.equal(looksLikeMarkdown("# Briefing\n\nthe rest"), true, "heading");
  assert.equal(looksLikeMarkdown("run this:\n```sh\nls\n```"), true, "fence");
  assert.equal(looksLikeMarkdown("what we know:\n- one\n- two"), true, "bullet list");
  assert.equal(looksLikeMarkdown("steps:\n1. first\n2. second"), true, "numbered list");
  assert.equal(looksLikeMarkdown("> quoted from the ticket"), true, "block quote");
  assert.equal(looksLikeMarkdown("| a | b |\n| - | - |"), true, "table");
  assert.equal(looksLikeMarkdown("see [the runbook](https://example.invalid/x)"), true, "link");
  assert.equal(looksLikeMarkdown("this is **urgent** today"), true, "bold");
});

test("a log file is not markdown", () => {
  const log = [
    "2026-09-05T14:12:33Z host started",
    "2026-09-05T14:12:34Z provider warm",
    "2026-09-05T14:12:40Z turn accepted (nonce c8f1)",
    "TypeError: cannot read property foo of undefined",
    "    at readThing (/home/box/sand-data/thing.js:41:7)",
  ].join("\n");
  assert.equal(looksLikeMarkdown(log), false);
  assert.equal(looksLikeMarkdown("plain sentence with snake_case_names and a_b__c in it"), false);
  assert.equal(looksLikeMarkdown(""), false);
});

test("the file is named for when it was pasted, to the second", () => {
  const at = new Date(2026, 8, 5, 14, 12, 33); // local time, the same clock the operator reads
  assert.equal(pastedFileName("# Briefing\n\nthe rest", at), "pasted-20260905-141233.md");
  assert.equal(pastedFileName("just a wall of prose", at), "pasted-20260905-141233.txt");
});

test("every part of the stamp is padded, so the name sorts", () => {
  const at = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(pastedFileName("prose", at), "pasted-20260102-030405.txt");
  assert.match(pastedFileName("prose"), /^pasted-\d{8}-\d{6}\.(md|txt)$/, "and the default clock makes the same shape");
});
