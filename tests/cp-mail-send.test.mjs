// The send log, on the side that owns it (MAIL-3, docs/MAIL.md).
//
// The relay holds the Resend key and forces the From; this service holds the RECORD, and the record
// is the whole justification for the route existing. So the claims worth a test are:
//
//   the row is written BEFORE the mail goes and settled after it, so a crash leaves a row reading
//   `sending` rather than a send nobody can see;
//
//   the caps count EVERY CLAIMED ROW in the window -- what went, what is still in flight, and what
//   the provider refused. Anything counted low is the unsafe direction, and a rejected send still
//   cost a call to the operator's shared account, so a bot in a loop must run out of hour;
//
//   and the two new columns reach a database that already has this table. mail_send_log is LIVE on
//   the R750 with seven columns and no resend_id, and CREATE TABLE IF NOT EXISTS does exactly
//   nothing to a table that is already there. A fresh in-memory store proves none of that, so the
//   case that matters builds the seven-column table by hand and opens the store on it.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../cp/store.mjs";
import { SEND_CAP_DAILY_WORKSPACE, SEND_CAP_HOURLY_AGENT, createMailSends } from "../cp/mail.mjs";
import { startControlPlane } from "./cp-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const memory = () => openStore({ file: ":memory:" });

// A clock the caps can be walked past without a test that sleeps.
const clockFrom = (start) => { let at = start; return { now: () => at, advance(ms) { at += ms; } }; };

test("a claim is one row reading sending, and settling it writes the outcome and the Resend id", () => {
  const store = memory();
  try {
    const sends = createMailSends({ store });
    const claim = sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" });
    assert.equal(claim.ok, true);
    assert.equal(typeof claim.id, "number");

    const open = store.listMailSends("demo", 10);
    assert.equal(open.length, 1);
    assert.equal(open[0].outcome, "sending", "the row exists before the mail does");
    assert.equal(open[0].to, "jane@client.example");
    assert.equal(open[0].resendId, "");

    sends.closeSend(claim.id, "sent", "49a3999c-1111-4000-8000-000000000000", "");
    const settled = store.listMailSends("demo", 10);
    assert.equal(settled.length, 1, "settling updates the row rather than writing a second one");
    assert.equal(settled[0].outcome, "sent");
    assert.equal(settled[0].resendId, "49a3999c-1111-4000-8000-000000000000");
    assert.equal(settled[0].agentName, "", "the name comes from the directory, and this bot has no address row");
  } finally { store.close(); }
});

test("the log holds addresses and an outcome and never a subject or a body", () => {
  const store = memory();
  try {
    const sends = createMailSends({ store });
    const claim = sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" });
    sends.closeSend(claim.id, "sent", "re_1", "");
    const row = store.listMailSends("demo", 10)[0];
    // The customer's subject lives on their own volume in their own sent ledger, read by their own
    // console. The super admin's list is who sent to whom and whether it went.
    for (const forbidden of ["subject", "text", "html", "body"]) {
      assert.equal(Object.keys(row).includes(forbidden), false, `${forbidden} has no business in this table`);
    }
  } finally { store.close(); }
});

test("the newest send is first, and one workspace never sees another's", () => {
  const store = memory();
  try {
    const sends = createMailSends({ store });
    for (const to of ["one@x.example", "two@x.example", "three@x.example"]) {
      sends.closeSend(sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to }).id, "sent", "re_x", "");
    }
    sends.closeSend(sends.openSend({ slug: "titanium", agentId: "t_titan", code: "633973", to: "jason@x.example" }).id, "sent", "re_y", "");

    const demo = sends.listSends("demo", 10);
    assert.deepEqual(demo.map((row) => row.to), ["three@x.example", "two@x.example", "one@x.example"]);
    assert.equal(demo.every((row) => row.tenant === "demo"), true);
    assert.equal(sends.listSends("titanium", 10).length, 1);
    assert.equal(sends.listSends("nobody", 10).length, 0);
  } finally { store.close(); }
});

test("the bot's name on the operator's list comes from the directory and not from the caller", () => {
  const store = memory();
  try {
    // The row carries a code, not a name: a name typed by a customer has no business being copied
    // into the operator's record where it would then be stale the moment the bot is renamed.
    store.mintMailCode({ tenant: "demo", agentId: "a_titan", agentName: "Titan", domain: "myagents.email" });
    const code = store.listMailAddresses("demo")[0].code;
    const sends = createMailSends({ store });
    sends.closeSend(sends.openSend({ slug: "demo", agentId: "a_titan", code, to: "jane@client.example" }).id, "sent", "re_1", "");
    assert.equal(sends.listSends("demo", 10)[0].agentName, "Titan");
  } finally { store.close(); }
});

// ---- the caps -----------------------------------------------------------------------------------

test("a bot's thirty-first send in an hour is refused, and the refusal names thirty", () => {
  const store = memory();
  const clock = clockFrom(Date.parse("2026-09-09T12:00:00Z"));
  try {
    const sends = createMailSends({ store, now: clock.now });
    assert.equal(sends.sendCaps("demo").hourlyPerAgent, SEND_CAP_HOURLY_AGENT);
    for (let n = 0; n < SEND_CAP_HOURLY_AGENT; n += 1) {
      const claim = sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" });
      assert.equal(claim.ok, true, `send ${n + 1} of ${SEND_CAP_HOURLY_AGENT}`);
      sends.closeSend(claim.id, "sent", "re_x", "");
      clock.advance(1000);
    }
    const over = sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" });
    assert.equal(over.ok, false);
    assert.equal(over.error, "rate_limited");
    assert.equal(over.scope, "agent");
    assert.equal(over.cap, 30);
    assert.match(over.message, /30/);
    assert.ok(over.retryAfterSeconds > 0, "and it says when the next one can go");
    assert.equal(store.listMailSends("demo", 100).length, 30, "a refused send writes no row");

    // Another bot in the same workspace is untouched: the hourly cap is per bot.
    assert.equal(sends.openSend({ slug: "demo", agentId: "a_books", code: "247759", to: "jane@client.example" }).ok, true);

    // An hour later the window has moved on.
    clock.advance(3600_000);
    assert.equal(sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" }).ok, true);
  } finally { store.close(); }
});

test("a workspace's two hundred and first send in a day is refused, and the refusal names two hundred", () => {
  const store = memory();
  const clock = clockFrom(Date.parse("2026-09-09T00:00:00Z"));
  try {
    const sends = createMailSends({ store, now: clock.now });
    assert.equal(sends.sendCaps("demo").dailyPerWorkspace, SEND_CAP_DAILY_WORKSPACE);
    // Spread over enough bots that the per-bot cap is never what refuses.
    for (let n = 0; n < SEND_CAP_DAILY_WORKSPACE; n += 1) {
      const claim = sends.openSend({ slug: "demo", agentId: `a_${n % 20}`, code: "247758", to: "jane@client.example" });
      assert.equal(claim.ok, true, `send ${n + 1}`);
      sends.closeSend(claim.id, "sent", "re_x", "");
      clock.advance(1000);
    }
    const over = sends.openSend({ slug: "demo", agentId: "a_fresh", code: "247758", to: "jane@client.example" });
    assert.equal(over.ok, false);
    assert.equal(over.scope, "workspace");
    assert.equal(over.cap, 200);
    assert.match(over.message, /200/);
    // Another workspace is untouched.
    assert.equal(sends.openSend({ slug: "titanium", agentId: "t_titan", code: "633973", to: "a@b.example" }).ok, true);
  } finally { store.close(); }
});

test("every claimed row counts, whatever became of it, and a failure gets no place back", () => {
  const store = memory();
  const clock = clockFrom(Date.parse("2026-09-09T12:00:00Z"));
  try {
    const sends = createMailSends({ store, now: clock.now });
    // Twenty-nine crashes: rows left reading `sending`, which is "we do not know". They count,
    // because counting an unknown low is the direction that lets a bug send unbounded mail.
    for (let n = 0; n < 29; n += 1) sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "j@x.example" });
    // And one we know did not go. The first cut of this gave that one its place back, on the
    // reasoning that no mail left. But a send the provider rejected still COST A CALL to the
    // operator's shared account, and a bot in a loop fails every time -- so a cap that only
    // counted successes was no cap at all against exactly the caller it exists to stop.
    const failed = sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "j@x.example" });
    sends.closeSend(failed.id, "failed", "", "Resend said the domain is not verified");
    assert.equal(sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "j@x.example" }).ok, false,
      "thirty claims in the hour is thirty, and one of them having failed changes nothing");
    // And an hour later the window has moved and the bot may send again.
    clock.advance(3_600_001);
    assert.equal(sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "j@x.example" }).ok, true,
      "the cap is a window and not a ban");
  } finally { store.close(); }
});

test("both caps are settings, globally and per workspace, and the operator gets no exemption", () => {
  const store = memory();
  try {
    const sends = createMailSends({ store });
    store.setSetting("mail.send.hourlyPerAgent", "2", "a test");
    assert.equal(sends.sendCaps("demo").hourlyPerAgent, 2);
    store.setSetting("mail.send.hourlyPerAgent.demo", "5", "a test");
    assert.equal(sends.sendCaps("demo").hourlyPerAgent, 5, "the per-workspace name wins");
    assert.equal(sends.sendCaps("titanium").hourlyPerAgent, 2, "and nobody else moved");
    store.setSetting("mail.send.dailyPerWorkspace.titanium", "9", "a test");
    assert.equal(sends.sendCaps("titanium").dailyPerWorkspace, 9);
    // A cap that exempted the operator would hide its own bugs from the only person who would
    // notice, so there is no branch here that reads a slug and skips the count.
    assert.equal(sends.sendCaps("titanium").hourlyPerAgent, 2);
    // Nonsense in the row falls back rather than uncapping anybody.
    store.setSetting("mail.send.hourlyPerAgent", "not a number", "a test");
    assert.equal(sends.sendCaps("demo").hourlyPerAgent, 5);
    store.setSetting("mail.send.hourlyPerAgent.demo", "-3", "a test");
    assert.equal(sends.sendCaps("demo").hourlyPerAgent, SEND_CAP_HOURLY_AGENT);
  } finally { store.close(); }
});

test("a workspace and a bot have to be named", () => {
  const store = memory();
  try {
    const sends = createMailSends({ store });
    assert.equal(sends.openSend({ slug: "", agentId: "a", code: "1", to: "a@b.example" }).ok, false);
    assert.equal(sends.openSend({ slug: "demo", agentId: "", code: "1", to: "a@b.example" }).ok, false);
    assert.equal(store.listMailSends("demo", 10).length, 0);
  } finally { store.close(); }
});

// ---- the migration, which is the case a fresh store cannot make ----------------------------------

test("a database whose mail_send_log has the seven live columns gains resend_id and detail", async () => {
  // This is the R750's table as it stands, built by hand here because that is the only way to have
  // one. db.exec(SCHEMA) does nothing at all to a table that already exists, so without the two
  // ALTERs the first claim on the server would fail in a way that reads like Resend refusing.
  const dir = await mkdtemp(path.join(os.tmpdir(), "cp-mail-send-migrate-"));
  const file = path.join(dir, "control-plane.sqlite");
  const seeded = new DatabaseSync(file);
  seeded.exec(`CREATE TABLE mail_send_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant   TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    code     TEXT NOT NULL DEFAULT '',
    to_addr  TEXT NOT NULL DEFAULT '',
    at       TEXT NOT NULL,
    outcome  TEXT NOT NULL DEFAULT ''
  )`);
  seeded.exec("INSERT INTO mail_send_log (tenant, agent_id, code, to_addr, at, outcome) "
    + "VALUES ('demo', 'a_old', '247758', 'old@client.example', '2026-09-01T00:00:00.000Z', 'sent')");
  seeded.close();

  const store = openStore({ file });
  try {
    const sends = createMailSends({ store });
    const claim = sends.openSend({ slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" });
    assert.equal(claim.ok, true, "a claim against the migrated table works");
    sends.closeSend(claim.id, "sent", "49a3999c-2222-4000-8000-000000000000", "");
    const rows = store.listMailSends("demo", 10);
    assert.equal(rows.length, 2, "the row that was already there is still there");
    assert.equal(rows[0].resendId, "49a3999c-2222-4000-8000-000000000000", "and the new column reads back");
    assert.equal(rows[1].resendId, "", "the old row got the default");
  } finally { store.close(); }
});

// ---- the two relay routes and the operator's read -------------------------------------------------

test("open and close are behind the relay's credential, and the read is behind the admin's", async () => {
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    const admin = cp.config.adminToken;
    const claimBody = { slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example", idem: "a_titan:call_1" };

    // The relay's credential, and nothing else, opens the claim.
    assert.equal((await cp.request("POST", "/v1/relay/mail/send/open", { body: claimBody })).status, 401);
    assert.equal((await cp.request("POST", "/v1/relay/mail/send/open", { body: claimBody, token: admin })).status, 401);
    assert.equal((await cp.request("GET", "/v1/relay/mail/send/open", { token: relayToken })).status, 405);

    const opened = await cp.request("POST", "/v1/relay/mail/send/open", { body: claimBody, token: relayToken });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.ok, true);
    const id = opened.body.id;

    const closed = await cp.request("POST", "/v1/relay/mail/send/close", {
      body: { id, outcome: "sent", resendId: "re_live_1", detail: "" }, token: relayToken,
    });
    assert.equal(closed.status, 200);

    // The operator's read is a super admin route, and the relay's credential does not open it.
    assert.equal((await cp.request("GET", "/v1/mail/sends?slug=demo")).status, 401);
    assert.equal((await cp.request("GET", "/v1/mail/sends?slug=demo", { token: relayToken })).status, 401);
    const listed = await cp.request("GET", "/v1/mail/sends?slug=demo", { token: admin });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rows.length, 1);
    assert.equal(listed.body.rows[0].to, "jane@client.example");
    assert.equal(listed.body.rows[0].outcome, "sent");
    assert.equal(listed.body.rows[0].resendId, "re_live_1");
    // No subject anywhere on this route, because there is none in the table.
    assert.equal(listed.text.includes("subject"), false);
  } finally { await cp.dispose(); }
});

test("a cap refusal comes back as a 429 the relay can pass on word for word", async () => {
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    // The cap arithmetic is proved over the module above. What this asserts is that the ROUTE
    // answers 429 rather than 500 when the module refuses, and that the sentence survives the wire
    // -- because the relay reads that sentence back to a person word for word.
    const body = { slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" };
    let refusal = null;
    for (let n = 0; n < SEND_CAP_HOURLY_AGENT + 2 && refusal == null; n += 1) {
      const answer = await cp.request("POST", "/v1/relay/mail/send/open", { body, token: relayToken });
      if (answer.status !== 200) refusal = answer;
    }
    assert.ok(refusal != null, "the cap refuses eventually");
    assert.equal(refusal.status, 429);
    assert.equal(refusal.body.error, "rate_limited");
    assert.equal(typeof refusal.body.message, "string");
  } finally { await cp.dispose(); }
});

// ---- and the verb, which may not open a database ---------------------------------------------------

test("mail sends asks the service and opens no sqlite file of its own", async () => {
  // MAIL-CLI-1. On the R750 the store is inside the control plane container and the operator types
  // this on his Mac: a verb that opened the store would answer "nothing sent yet" over a live log
  // and nothing would error. So the verb is run for real, pointed at a scratch service, in a data
  // directory it must leave empty.
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cp-cli-mail-sends-"));
  try {
    const opened = await cp.request("POST", "/v1/relay/mail/send/open", {
      body: { slug: "demo", agentId: "a_titan", code: "247758", to: "jane@client.example" }, token: relayToken,
    });
    await cp.request("POST", "/v1/relay/mail/send/close", {
      body: { id: opened.body.id, outcome: "sent", resendId: "re_cli_1" }, token: relayToken,
    });

    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(repoRoot, "cp", "cli.mjs"), "mail", "sends", "demo"], {
        env: {
          ...process.env,
          CP_PUBLIC_URL: cp.base,
          CP_ADMIN_TOKEN: cp.config.adminToken,
          CP_DATA_DIR: dataDir,
        },
      }, (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out)));
    });
    assert.match(stdout, /jane@client\.example/);
    assert.match(stdout, /re_cli_1/);
    assert.deepEqual(await readdir(dataDir), [], "the verb opened no database of its own");
  } finally { await cp.dispose(); }
});
