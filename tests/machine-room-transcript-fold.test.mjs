// A subagent's steps drew one "Computer · running" row each, seventeen in a column (Jason,
// 2026-09-07 22:11). Consecutive system rows with the same words and no receipt fold into one
// row with a count; a row with a receipt or a peer exchange never folds.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function helpers() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const grab = (name) => {
    const start = source.indexOf(`  function ${name}(`);
    assert.notEqual(start, -1, `app.js no longer defines ${name}`);
    const end = source.indexOf("\n  }\n", start);
    return source.slice(start, end + 4);
  };
  return new Function(`${grab("foldRepeatedRows")}\nreturn { foldRepeatedRows };`)();
}

const sys = (id, text, extra = {}) => ({ id, type: "system", text, ...extra });

test("a run of identical receipt-less system rows becomes one row with a count", async () => {
  const { foldRepeatedRows } = await helpers();
  const rows = foldRepeatedRows([
    { id: "m1", type: "message", text: "On it." },
    sys("t1", "Computer · running"), sys("t2", "Computer · running"), sys("t3", "Computer · running"),
    sys("t4", "Accepted by the host"),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].text, "Computer · running");
  assert.equal(rows[1].count, 3);
  assert.equal(rows[1].id, "t3", "the folded row keeps the newest id so a reveal still lands on it");
  assert.equal(rows[2].count, undefined);
});

test("rows with receipts, exchanges, or different words stay separate", async () => {
  const { foldRepeatedRows } = await helpers();
  const rows = foldRepeatedRows([
    sys("s1", "Shell · ls", { detail: "$ ls\nfile" }), sys("s2", "Shell · ls", { detail: "$ ls\nfile" }),
    sys("x1", "2 messages with Scribe", { exchange: {} }), sys("x2", "2 messages with Scribe", { exchange: {} }),
    sys("c1", "Computer · running"), sys("c2", "Computer"),
  ]);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.count === undefined));
});

test("the transcript renders the count in plain words", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  assert.match(source, /foldRepeatedRows\(contextMessages\(\)\)\.map\(messageMarkup\)/);
  assert.match(source, /`\$\{message\.text\} · \$\{message\.count\} steps`/);
});
