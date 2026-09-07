// ADMIN-1. The relay's failed sign-in ledger: the keyed hash, the rotation, the row shape, and the
// one property that matters more than all of them, which is that a password that was tried is never
// on the disk.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DOORS,
  LEDGER_MAX_BYTES,
  OUTCOMES,
  USER_AGENT_LIMIT,
  createLoginLedger,
  filterAttempts,
  hashTried,
  loginAttemptRow,
  readLedgerFile,
  readOrCreateSalt,
} from "../ui/login-ledger.mjs";

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "login-ledger-"));
  try { await run(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const saltOf = (dir) => readFile(path.join(dir, "login-attempt-salt"), "utf8").then((text) => text.trim());

test("the salt is made once, at 0600, and read back after that", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "salt");
    const first = readOrCreateSalt(file);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(readOrCreateSalt(file), first, "a second call reads the file rather than replacing it");

    // A file that was truncated, or was never a salt, is replaced rather than used. Hashing under
    // an empty key would make every row's hash the same, which is worse than losing the history.
    await writeFile(file, "");
    const replaced = readOrCreateSalt(file);
    assert.match(replaced, /^[0-9a-f]{64}$/);
    assert.notEqual(replaced, first);
  });
});

test("the hash is HMAC-SHA256 of the password under the salt, and nothing without both", () => {
  const salt = randomBytes(32).toString("hex");
  const expected = createHmac("sha256", salt).update("a-tried-password", "utf8").digest("hex");
  assert.equal(hashTried("a-tried-password", salt), expected);
  assert.equal(hashTried("a-tried-password", salt).length, 64);
  // Two different passwords under one salt differ; one password under two salts differs. Both
  // matter: the first is what makes "different passwords" countable, the second is why a stolen
  // relay ledger cannot be compared against a stolen control plane one.
  assert.notEqual(hashTried("a-tried-password", salt), hashTried("a-tried-passwore", salt));
  assert.notEqual(hashTried("a-tried-password", salt), hashTried("a-tried-password", randomBytes(32).toString("hex")));
  assert.equal(hashTried("", salt), "", "an empty password hashes to nothing, because it is not evidence of anything");
  assert.equal(hashTried("a-tried-password", ""), "", "and neither is a hash under a key we do not have");
});

test("a row is forced into shape, whatever a stranger typed", () => {
  const row = loginAttemptRow({
    at: 1_700_000_000_000,
    door: "made-up",
    email: "  Owner@Example.COM  ",
    ip: "203.0.113.9",
    userAgent: "x".repeat(400),
    triedHash: "not a hash",
    outcome: "banana",
    tenant: "acme",
  });
  assert.equal(row.at, new Date(1_700_000_000_000).toISOString());
  assert.equal(row.door, "instance", "an unknown door falls back to the one an empty email would take");
  assert.equal(row.email, "owner@example.com");
  assert.equal(row.userAgent.length, USER_AGENT_LIMIT);
  assert.equal(row.triedHash, "", "anything that is not a 64 character hex digest is dropped, so a caller cannot write a password into this field");
  assert.equal(row.outcome, "refused", "an unknown outcome is a refusal, which is the safe reading");
  assert.deepEqual(Object.keys(row).sort(), ["at", "door", "email", "ip", "outcome", "tenant", "triedHash", "userAgent"]);
  assert.ok(DOORS.has("account") && DOORS.has("instance"));
  assert.ok(OUTCOMES.has("ok") && OUTCOMES.has("refused") && OUTCOMES.has("locked"));
});

test("a refusal is written with a hash and a success is written without one", async () => {
  await withDir(async (dir) => {
    const ledger = createLoginLedger({ dir });
    await ledger.record({ door: "account", email: "Owner@Example.com", ip: "203.0.113.9", userAgent: "curl/8", outcome: "refused", password: "the-wrong-one" });
    await ledger.record({ door: "account", email: "owner@example.com", ip: "203.0.113.9", outcome: "ok", password: "the-right-one", tenant: "acme" });
    await ledger.record({ door: "instance", ip: "203.0.113.9", outcome: "locked" });

    const rows = await ledger.rows();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].email, "owner@example.com");
    assert.equal(rows[0].triedHash, hashTried("the-wrong-one", await saltOf(dir)));
    assert.equal(rows[1].triedHash, "", "a password that WORKED leaves nothing behind: a file of keyed hashes with one known-good entry in it is a worse file than one with none");
    assert.equal(rows[1].tenant, "acme");
    assert.equal(rows[2].triedHash, "", "a lockout answers before the body is read, so there is no password to hash");
    assert.equal((await stat(ledger.file)).mode & 0o777, 0o600);
  });
});

test("neither password is anywhere in the file", async () => {
  await withDir(async (dir) => {
    const ledger = createLoginLedger({ dir });
    for (const password of ["hunter2", "correct horse battery staple", "P@ssw0rd!"]) {
      await ledger.record({ door: "account", email: "owner@example.com", ip: "203.0.113.9", outcome: "refused", password });
      await ledger.record({ door: "account", email: "owner@example.com", ip: "203.0.113.9", outcome: "ok", password });
    }
    const raw = await readFile(ledger.file, "utf8");
    for (const password of ["hunter2", "correct horse battery staple", "P@ssw0rd!"]) {
      assert.equal(raw.includes(password), false, `${password} is on the disk`);
    }
    const salt = await readFile(ledger.saltFile, "utf8");
    assert.equal(raw.includes(salt.trim()), false, "and the salt is not in the ledger either, so the file alone cannot be run through a dictionary");
  });
});

test("the same password twice hashes the same, and a different one does not", async () => {
  await withDir(async (dir) => {
    const ledger = createLoginLedger({ dir });
    await ledger.record({ ip: "1.1.1.1", outcome: "refused", password: "same" });
    await ledger.record({ ip: "1.1.1.1", outcome: "refused", password: "same" });
    await ledger.record({ ip: "1.1.1.1", outcome: "refused", password: "other" });
    const rows = await ledger.rows();
    // This is the whole reason the hash exists: the panel has to be able to say "the same password
    // three times" versus "three different passwords", and this is what makes that countable.
    assert.equal(rows[0].triedHash, rows[1].triedHash);
    assert.notEqual(rows[0].triedHash, rows[2].triedHash);
    assert.equal(new Set(rows.map((row) => row.triedHash)).size, 2);
  });
});

test("past the cap the file rotates, and exactly one previous file is kept", async () => {
  await withDir(async (dir) => {
    const ledger = createLoginLedger({ dir, maxBytes: 2048 });
    let written = 0;
    let rotatedAfter = 0;
    // Counted rather than guessed at: a fixed number of rows would depend on how wide a row happens
    // to be, which is how a test starts passing for the wrong reason.
    for (let index = 0; index < 500 && rotatedAfter === 0; index += 1) {
      await ledger.record({ door: "account", email: `person${index}@example.com`, ip: "203.0.113.9", outcome: "refused", password: `try-${index}` });
      written += 1;
      try { await stat(ledger.previousFile); rotatedAfter = written; } catch { /* not yet */ }
    }
    assert.ok(rotatedAfter > 0, "the file rotated");
    await ledger.record({ door: "account", email: "after@example.com", ip: "203.0.113.9", outcome: "refused", password: "after" });
    written += 1;

    assert.ok((await stat(ledger.file)).size < 2048, "the live file starts again under the cap");
    const all = await ledger.rows();
    assert.equal(all.length, written, "nothing was lost: both files are read back as one list");
    assert.equal(all[0].email, "person0@example.com", "oldest first, so the previous file comes before the live one");
    assert.equal(all[all.length - 1].email, "after@example.com");

    // Rotate a second time and the first previous file goes. That is the point of the cap: the
    // ceiling on disk is two files, whatever happens.
    const firstKept = await readFile(ledger.previousFile, "utf8");
    for (let index = 0; index < 500; index += 1) {
      await ledger.record({ door: "account", email: `later${index}@example.com`, ip: "203.0.113.9", outcome: "refused", password: `later-${index}` });
      if (!(await readFile(ledger.previousFile, "utf8")).startsWith(firstKept.slice(0, 40))) break;
    }
    const second = await readFile(ledger.previousFile, "utf8");
    assert.notEqual(second, firstKept, "the second rotation replaced the first previous file");
    assert.equal(second.includes("person0@example.com"), false);
  });
});

test("a torn line does not take the panel down with it", async () => {
  await withDir(async (dir) => {
    const ledger = createLoginLedger({ dir });
    await ledger.record({ ip: "1.1.1.1", outcome: "refused", password: "one" });
    await writeFile(ledger.file, `${await readFile(ledger.file, "utf8")}{"at":"2026-09-07T00:00:0`, { flag: "w" });
    const rows = await readLedgerFile(ledger.file);
    assert.equal(rows.length, 1, "the whole rows survive and the half one is dropped");
    assert.deepEqual(await readLedgerFile(path.join(dir, "not-there.jsonl")), [], "a file that is not there reads as no rows, not as an error");
  });
});

test("a write that cannot happen does not take the sign-in down with it", async () => {
  const ledger = createLoginLedger({ dir: "/this/directory/does/not/exist", log: () => {} });
  assert.equal(await ledger.record({ ip: "1.1.1.1", outcome: "refused", password: "x" }), null);
  assert.deepEqual(await ledger.rows(), [], "and reading answers nothing rather than throwing");
});

test("the filter takes a window, an outcome and a cap, newest first", () => {
  const rows = [
    { at: "2026-09-07T10:00:00.000Z", outcome: "refused", ip: "a" },
    { at: "2026-09-07T11:00:00.000Z", outcome: "ok", ip: "b" },
    { at: "2026-09-07T12:00:00.000Z", outcome: "refused", ip: "c" },
    { at: "not a time", outcome: "refused", ip: "d" },
  ];
  // Newest first, and the row whose timestamp does not parse sorts to the bottom rather than
  // wherever a NaN comparator happens to leave it.
  assert.deepEqual(filterAttempts(rows).map((row) => row.ip), ["c", "b", "a", "d"]);
  assert.deepEqual(filterAttempts(rows, { outcome: "refused" }).map((row) => row.ip), ["c", "a", "d"]);
  assert.deepEqual(filterAttempts(rows, { since: "2026-09-07T10:30:00.000Z" }).map((row) => row.ip), ["c", "b"]);
  assert.equal(filterAttempts(rows, { limit: 1 }).length, 1);
  assert.equal(LEDGER_MAX_BYTES, 5 * 1024 * 1024);
});
