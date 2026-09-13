// The welcome bar's control-plane half (DISCOVER-1): one person's own flag, and the one voice fact.
//
// This service owns exactly two of the seven things GET /discover needs, and it owns them because
// they are not on the relay and cannot be:
//
//   voice_sessions is HERE. It is the only record in this product that a call happened, the day cap
//   is read out of the same rows, and a relay that kept its own copy would be a second number for
//   one fact. The row counted is SETTLED and over the threshold, because an open row has no
//   wall_seconds until the settle writes one, and cp/voice.mjs has a sweep for rows left open by a
//   relay that went away -- so counting an open one would tick the step on a pressed button;
//
//   the Hide flag is HERE because it is a PERSON's and a person's account is here. accounts.tenant
//   carries no UNIQUE constraint, which is the whole reason ui/server.mjs has subOf at all, so a
//   workspace-level setting would take the bar off a colleague's screen.
//
// The claims worth a test are the split's own failure modes: the door (one credential, and not the
// admin one), the person (one row per sub and never another's), the threshold (open rows, short
// rows, another workspace's rows), and that the new table lands on a database that already exists --
// which is the failure mail_send_log actually had on the R750 and the reason cp-voice has the same
// test written the same way.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore, PERSON_FLAG_NAME_LIMIT, PERSON_FLAG_VALUE_LIMIT, PERSON_SUB_LIMIT } from "../cp/store.mjs";
import { DISCOVER_HIDDEN_FLAG, DISCOVER_VOICE_CALL_SECONDS } from "../cp/server.mjs";
import { startControlPlane } from "./cp-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const memory = () => openStore({ file: ":memory:" });
const RELAY_TOKEN = "r".repeat(40);
const NOON = Date.parse("2026-09-13T12:00:00.000Z");

/** A settled call of `seconds`, on `tenant`. The claim and the settle are two writes on the real
 *  ledger, the way cp/voice.mjs makes them, so nothing here invents a row shape. */
function loggedCall(store, { tenant, sessionId, seconds, at = "2026-09-13T11:00:00.000Z", settle = true }) {
  store.openVoiceSession({ sessionId, tenant, agentId: "a-1", vendor: "xai", model: "", at });
  if (settle) store.closeVoiceSession(sessionId, { endedAt: at, wallSeconds: seconds });
}

// ---- the flag ------------------------------------------------------------------------------------

test("a flag belongs to one person on one workspace and to nobody else", () => {
  const store = memory();
  try {
    const mine = { tenant: "demo", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG };
    const theirs = { tenant: "demo", sub: "acct-2", name: DISCOVER_HIDDEN_FLAG };
    const elsewhere = { tenant: "other", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG };
    assert.equal(store.getPersonFlag(mine), "", "a person who has never chosen reads as empty, never as null");

    store.setPersonFlag({ ...mine, value: "1", at: NOON });
    assert.equal(store.getPersonFlag(mine), "1");
    assert.equal(store.getPersonFlag(theirs), "", "one person's Hide reached their colleague");
    assert.equal(store.getPersonFlag(elsewhere), "", "one workspace's Hide reached another workspace");

    // The instance-password door names nobody, and "" is a real person here rather than a missing
    // argument: it is how the relay writes the operator's own choice everywhere else.
    store.setPersonFlag({ tenant: "demo", sub: "", name: DISCOVER_HIDDEN_FLAG, value: "1", at: NOON });
    assert.equal(store.getPersonFlag({ tenant: "demo", sub: "", name: DISCOVER_HIDDEN_FLAG }), "1");
    assert.equal(store.getPersonFlag(mine), "1", "the instance door overwrote a named person's row");
  } finally { store.close(); }
});

test("Show clears the row rather than writing a second spelling of no", () => {
  const store = memory();
  try {
    const row = { tenant: "demo", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG };
    store.setPersonFlag({ ...row, value: "1", at: NOON });
    store.setPersonFlag({ ...row, value: "", at: NOON + 1_000 });
    assert.equal(store.getPersonFlag(row), "");
    // Never chosen and chose the default are one fact, so there is no row left behind for it. Two
    // spellings of the same state is how a later reader ends up with three states for a checkbox.
    const held = store.db.prepare("SELECT COUNT(*) AS n FROM person_flags").get().n;
    assert.equal(held, 0, "Show left a row behind");
  } finally { store.close(); }
});

test("a second Hide moves the time and never duplicates the row", () => {
  const store = memory();
  try {
    const row = { tenant: "demo", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG };
    store.setPersonFlag({ ...row, value: "1", at: NOON });
    store.setPersonFlag({ ...row, value: "1", at: NOON + 60_000 });
    const rows = store.db.prepare("SELECT * FROM person_flags").all();
    assert.equal(rows.length, 1, "two presses made two rows");
    assert.equal(Number(rows[0].at), NOON + 60_000);
  } finally { store.close(); }
});

test("the three bounds hold, because the key is made of strings a caller supplies", () => {
  const store = memory();
  try {
    const long = (n) => "x".repeat(n);
    store.setPersonFlag({ tenant: "demo", sub: long(PERSON_SUB_LIMIT + 40), name: DISCOVER_HIDDEN_FLAG, value: long(200), at: NOON });
    const row = store.db.prepare("SELECT * FROM person_flags").get();
    assert.equal(String(row.sub).length, PERSON_SUB_LIMIT);
    assert.equal(String(row.value).length, PERSON_FLAG_VALUE_LIMIT);
    // A write with no workspace or no flag name is refused rather than stored under an empty key.
    assert.equal(store.setPersonFlag({ tenant: "", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG, value: "1" }), false);
    assert.equal(store.setPersonFlag({ tenant: "demo", sub: "acct-1", name: "", value: "1" }), false);
    assert.equal(store.getPersonFlag({ tenant: "", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG }), "");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM person_flags").get().n, 1);
    assert.ok(PERSON_FLAG_NAME_LIMIT >= DISCOVER_HIDDEN_FLAG.length, "the flag this wave writes does not fit its own bound");
  } finally { store.close(); }
});

// ---- the voice count ------------------------------------------------------------------------------

test("only a settled call over the threshold counts, and only this workspace's", () => {
  const store = memory();
  try {
    const count = (tenant) => store.countSettledVoiceSessions({ tenant, minSeconds: DISCOVER_VOICE_CALL_SECONDS });
    assert.equal(count("demo"), 0);

    // A press and a change of mind. The row is real and it is not a call.
    loggedCall(store, { tenant: "demo", sessionId: "v-short", seconds: 3 });
    assert.equal(count("demo"), 0, "a three second row ticked the step");

    // A call in progress. It has no wall_seconds yet, and cp/voice.mjs has a sweep because rows are
    // left open often enough to need one: counting it would tick the step on a pressed button.
    loggedCall(store, { tenant: "demo", sessionId: "v-open", seconds: 0, settle: false });
    assert.equal(count("demo"), 0, "an open row ticked the step");

    loggedCall(store, { tenant: "demo", sessionId: "v-real", seconds: 42 });
    assert.equal(count("demo"), 1);

    // Exactly at the threshold is over it: ten seconds is "at least ten".
    loggedCall(store, { tenant: "demo", sessionId: "v-edge", seconds: DISCOVER_VOICE_CALL_SECONDS });
    assert.equal(count("demo"), 2);

    // Another customer's calls are not this customer's.
    loggedCall(store, { tenant: "other", sessionId: "v-elsewhere", seconds: 90 });
    assert.equal(count("demo"), 2, "another workspace's call ticked this one's step");
    assert.equal(count("other"), 1);
    assert.equal(count(""), 0, "a read with no workspace answered a number");
  } finally { store.close(); }
});

// ---- the door ------------------------------------------------------------------------------------

test("the discover route answers the relay and nobody else", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    // The method refusal comes FIRST, the way the voice routes beside it do: a wrong method charges
    // nobody and learns nothing.
    assert.equal((await cp.request("DELETE", "/v1/relay/discover?slug=demo")).status, 405);

    assert.equal((await cp.request("GET", "/v1/relay/discover?slug=demo")).status, 401, "no bearer");
    assert.equal((await cp.admin("GET", "/v1/relay/discover?slug=demo")).status, 401,
      "the admin token opened the relay's door, and the two doors never do each other's job");
    assert.equal((await cp.request("POST", "/v1/relay/discover", { body: { slug: "demo", sub: "acct-1", hidden: true } })).status, 401);

    const relay = (method, pathname, body) => cp.request(method, pathname, { body, token: RELAY_TOKEN });
    assert.equal((await relay("GET", "/v1/relay/discover")).status, 400, "it names the workspace or it answers nothing");
    assert.equal((await relay("POST", "/v1/relay/discover", { sub: "acct-1", hidden: true })).status, 400);
    // hidden is a boolean and nothing else: a write with a missing or a stringly-typed flag is a
    // caller bug, and guessing what "0" meant is how a Hide becomes a Show.
    assert.equal((await relay("POST", "/v1/relay/discover", { slug: "demo", sub: "acct-1" })).status, 400);
    assert.equal((await relay("POST", "/v1/relay/discover", { slug: "demo", sub: "acct-1", hidden: "yes" })).status, 400);
  } finally { await cp.dispose(); }
});

test("the route reads and writes one person's bar, and the answer carries no secret", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    const relay = (method, pathname, body) => cp.request(method, pathname, { body, token: RELAY_TOKEN });
    const read = (sub) => relay("GET", `/v1/relay/discover?slug=demo&sub=${encodeURIComponent(sub)}`);

    const fresh = await read("acct-1");
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.hidden, false);
    assert.equal(fresh.body.voiceCalls, 0);
    assert.equal(fresh.body.voiceCallSeconds, DISCOVER_VOICE_CALL_SECONDS);
    assert.equal(fresh.body.tenant, "demo");

    assert.equal((await relay("POST", "/v1/relay/discover", { slug: "demo", sub: "acct-1", hidden: true })).body.hidden, true);
    assert.equal((await read("acct-1")).body.hidden, true);
    assert.equal((await read("acct-2")).body.hidden, false, "one person's Hide reached their colleague");
    assert.equal((await read("")).body.hidden, false, "one person's Hide reached the instance door");
    // The row is where it says it is, under the relay's own word for the person.
    assert.equal(cp.app.store.getPersonFlag({ tenant: "demo", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG }), "1");

    assert.equal((await relay("POST", "/v1/relay/discover", { slug: "demo", sub: "acct-1", hidden: false })).body.hidden, false);
    assert.equal((await read("acct-1")).body.hidden, false);

    // A real call on this workspace, written through the ledger, reaches the read.
    loggedCall(cp.app.store, { tenant: "demo", sessionId: "v-1", seconds: 31 });
    const after = await read("acct-1");
    assert.equal(after.body.voiceCalls, 1);

    // The whole body swept: a count and two booleans. Nothing credential-shaped and no address,
    // because this answer is drawn in a customer's window bar by way of the relay.
    assert.equal(/sk-|Bearer |xai-|authorization|password/i.test(after.text), false, `nothing credential-shaped: ${after.text}`);
    assert.equal(/https?:|wss:/.test(after.text), false, "the answer is facts, not an address");
  } finally { await cp.dispose(); }
});

test("a workspace nobody has heard of reads as an empty bar rather than a refusal", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    // The relay resolved the workspace before it called; this service is being asked two questions
    // about it, and neither has a different answer for a slug with no rows. A 404 here would be a
    // console drawing an error over a workspace that is being provisioned.
    const answer = await cp.request("GET", "/v1/relay/discover?slug=never-existed&sub=acct-1", { token: RELAY_TOKEN });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.hidden, false);
    assert.equal(answer.body.voiceCalls, 0);
  } finally { await cp.dispose(); }
});

// ---- the table, on a database that already exists --------------------------------------------------

test("person_flags is made on a database that already holds the other tables", async () => {
  // The same test cp-voice.test.mjs writes for voice_sessions, for the same reason: the R750's
  // control-plane database is live, and CREATE TABLE IF NOT EXISTS does nothing whatever to a
  // database it is not run against. A fresh in-memory store proves none of that.
  //
  // The old schema is cut out of the REAL SCHEMA rather than hand-written, so it cannot drift from
  // the product and pass for the wrong reason.
  const root = await mkdtemp(path.join(os.tmpdir(), "cp-discover-"));
  try {
    const file = path.join(root, "control-plane.sqlite");
    const storeSource = await readFile(path.join(repoRoot, "cp/store.mjs"), "utf8");
    const schema = /\nconst SCHEMA = `([\s\S]*?)\n`;/.exec(storeSource)?.[1];
    assert.notEqual(schema, undefined, "SCHEMA is no longer a template literal in cp/store.mjs");
    const before = schema.replace(/-- DISCOVER-1\.[\s\S]*$/, "");
    assert.equal(before.includes("person_flags"), false, "the cut did not remove this wave's DDL");
    assert.equal(before.includes("CREATE TABLE IF NOT EXISTS sign_in_links"), true, "the cut removed more than this wave's DDL");
    assert.equal(before.includes("CREATE TABLE IF NOT EXISTS voice_sessions"), true, "the cut removed more than this wave's DDL");
    const old = new DatabaseSync(file);
    old.exec(before);
    old.exec("INSERT INTO tenants (slug, name, status, created_at, updated_at) VALUES ('demo', 'Demo', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'person_flags'").get(), undefined,
      "the database this opens on must NOT already have the table, or it proves nothing");
    old.close();

    const store = openStore({ file });
    try {
      const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
      assert.equal(names.includes("person_flags"), true, `person_flags was not made: ${names.join(", ")}`);
      // And it works on that database, which is the only proof that matters.
      store.setPersonFlag({ tenant: "demo", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG, value: "1", at: NOON });
      assert.equal(store.getPersonFlag({ tenant: "demo", sub: "acct-1", name: DISCOVER_HIDDEN_FLAG }), "1");
      // The voice read lands on the table that was already there, unchanged.
      loggedCall(store, { tenant: "demo", sessionId: "v-1", seconds: 20 });
      assert.equal(store.countSettledVoiceSessions({ tenant: "demo", minSeconds: DISCOVER_VOICE_CALL_SECONDS }), 1);
      // The older tables survived, which is the other half of "this migration is a no-op on a live
      // database": a new table must not take anything with it.
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n, 1);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
