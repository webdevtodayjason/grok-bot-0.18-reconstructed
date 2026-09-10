// The coding task ledger, its caps, its two relay routes and the operator's read (CODE-1, docs/CODE.md).
//
// tests/cp-code-key.test.mjs owns the credential and the deployment. This file owns the RECORD, and
// the record is the whole justification for the routes existing. So the claims worth a test are:
//
//   the row is written BEFORE the container exists and settled after it, because an unstarted task is
//   recoverable and an unbilled container-hour is not;
//
//   a cap refusal writes NO ROW and comes back as a finished sentence the relay reads out word for
//   word, with the number in words;
//
//   the table appears on a fresh database AND on one that has never held it, which is what the R750's
//   control-plane.sqlite is: db.exec(SCHEMA) does nothing at all to a file that already exists, and
//   this table is not in that SCHEMA on purpose;
//
//   no title and no instructions are in the table, ever -- the rule mail_send_log holds about
//   subjects, for the same reason;
//
//   and the operator's read is a super admin route the relay's own credential does not open, while
//   the two relay routes are a credential the admin token does not open either.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openStore } from "../cp/store.mjs";
import { createProxyClient } from "../cp/proxy.mjs";
import { CODE_DEFAULTS, CODING_ALIAS, createCodeTasks } from "../cp/code.mjs";
import { startControlPlane } from "./cp-support.mjs";

const memory = () => openStore({ file: ":memory:" });
const clockFrom = (start) => { let at = start; return { now: () => at, advance(ms) { at += ms; } }; };

/**
 * A proxy that mints, answers a spend and revokes, and nothing else. Deliberately smaller than the
 * one in cp-code-key.test.mjs: this file is about the ledger, and a fixture with more surface than
 * its subject needs is a fixture that hides which call the subject actually made.
 */
async function startMintProxy() {
  const masterKey = `sk-master-${randomBytes(8).toString("hex")}`;
  const keys = new Map();
  const byAlias = new Map();
  let minted = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://fake-proxy.invalid");
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      const route = `${request.method} ${url.pathname}`;
      if (route === "POST /key/generate") {
        minted += 1;
        const value = `sk-task-${minted}`;
        keys.set(value, { key: value, keyId: `hashed-${minted}`, alias: String(body?.key_alias ?? ""), spend: 0.01 });
        byAlias.set(String(body?.key_alias ?? ""), value);
        return send(200, { key: value, token_id: `hashed-${minted}` });
      }
      if (route === "GET /key/info") {
        const asked = String(url.searchParams.get("key") ?? "");
        const record = keys.get(asked) ?? [...keys.values()].find((one) => one.keyId === asked);
        if (record == null) return send(400, { error: { message: "Key not found" } });
        return send(200, { info: { key_alias: record.alias, token: record.keyId, spend: record.spend } });
      }
      if (route === "POST /key/delete") {
        for (const alias of Array.isArray(body?.key_aliases) ? body.key_aliases : []) {
          const value = byAlias.get(String(alias));
          if (value !== undefined) { keys.delete(value); byAlias.delete(String(alias)); }
        }
        return send(200, { deleted_keys: body?.key_aliases ?? [] });
      }
      if (route === "GET /key/list") return send(200, { keys: [...keys.values()].map((one) => ({ key_alias: one.alias })) });
      return send(404, { error: { message: `no route ${route} on this stub` } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    masterKey,
    aliases: () => [...byAlias.keys()],
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// EVERY LEDGER BUILT IN THIS FILE WAITS NO TIME FOR THE SPEND, and the wait itself is measured in
// its own case below. readSpend polls /key/info until the figure is above zero, because the real build
// books a key's spend from a batch writer about fifteen seconds late and a close that read once would
// write a ZERO -- the one answer that is indistinguishable from free. Twenty seconds a close is right
// on the R750 and wrong in a test suite, so these pass 0 and the waiting is proved on purpose.
const ledgerOn = (proxy, { store = memory(), now } = {}) => ({
  store,
  tasks: createCodeTasks({
    store,
    spendWaitMs: 0,
    proxy: createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } }),
    ...(now ? { now } : {}),
  }),
});

// ---- the row ---------------------------------------------------------------------------------------

test("a claim is one row reading running, and closing it writes the minutes and the outcome", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    assert.equal(opened.ok, true);
    assert.equal(typeof opened.id, "number");
    assert.equal(opened.provider, CODE_DEFAULTS.provider);
    assert.equal(opened.model, CODING_ALIAS);
    assert.equal(opened.minutesCap, CODE_DEFAULTS.wallClockMinutes);
    assert.equal(opened.cpus, CODE_DEFAULTS.cpus);
    assert.equal(opened.memoryGb, CODE_DEFAULTS.memoryGb);

    // THE ROW EXISTS BEFORE ANY CONTAINER DOES. The relay has not created anything yet at this
    // point: it cannot, because it has only just been handed the credential.
    const open = tasks.listTasks("demo", 10);
    assert.equal(open.length, 1);
    assert.equal(open[0].outcome, "running");
    assert.equal(open[0].endedAt, "");
    assert.equal(open[0].minutes, null, "minutes are not known until the task ends");
    assert.equal(open[0].spendUsd, null);
    assert.equal(open[0].keyAlias, "titanbot-demo-code-t1");

    await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 7.5 });
    const settled = tasks.listTasks("demo", 10);
    assert.equal(settled.length, 1, "closing updated the row rather than writing a second one");
    assert.equal(settled[0].outcome, "done");
    assert.equal(settled[0].minutes, 7.5);
    assert.equal(settled[0].spendUsd, 0.01);
    assert.ok(settled[0].endedAt.length > 0);
  } finally { await proxy.close(); store.close(); }
});

test("the ledger holds who ran what and never a title or a word of the instructions", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    // A caller that tries to put them there gets them dropped: openTask takes no such parameter, so
    // this is the assertion that somebody adding one later has to walk past.
    const opened = await tasks.openTask({
      slug: "demo", agentId: "a_titan", taskId: "t1",
      title: "Refactor the billing module", instructions: "the customer's own words, at length",
    });
    await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 1 });
    const row = tasks.listTasks("demo", 10)[0];
    for (const forbidden of ["title", "instructions", "prompt", "files"]) {
      assert.equal(Object.keys(row).includes(forbidden), false, `${forbidden} has no business in this table`);
    }
    const everything = JSON.stringify(tasks.listTasks("demo", 10));
    assert.equal(everything.includes("Refactor the billing module"), false);
    assert.equal(everything.includes("the customer's own words"), false);
  } finally { await proxy.close(); store.close(); }
});

test("the newest task is first and one workspace never sees another's", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    for (const id of ["one", "two"]) {
      const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: id });
      await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 1 });
    }
    const other = await tasks.openTask({ slug: "titanium", agentId: "t_titan", taskId: "three" });
    await tasks.closeTask({ id: other.id, outcome: "done", minutes: 2 });

    assert.deepEqual(tasks.listTasks("demo", 10).map((row) => row.taskId), ["two", "one"]);
    assert.equal(tasks.listTasks("demo", 10).every((row) => row.tenant === "demo"), true);
    assert.equal(tasks.listTasks("titanium", 10).length, 1);
    assert.equal(tasks.listTasks("nobody", 10).length, 0);
  } finally { await proxy.close(); store.close(); }
});

test("a close that arrives twice leaves the first outcome standing", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 3 });
    // A relay that did not see its close answered retries it. Overwriting a measured outcome with a
    // second guess would lose whichever of the two was true.
    const again = await tasks.closeTask({ id: opened.id, outcome: "failed", minutes: 99 });
    assert.equal(again.ok, true);
    assert.equal(again.already, true);
    const row = tasks.listTasks("demo", 10)[0];
    assert.equal(row.outcome, "done");
    assert.equal(row.minutes, 3);
  } finally { await proxy.close(); store.close(); }
});

test("the same task id twice is refused rather than claimed twice", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    assert.equal((await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" })).ok, true);
    const again = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    assert.equal(again.ok, false);
    assert.equal(again.error, "bad_request");
    assert.match(again.message, /already been claimed once, so nothing was started/);
    assert.equal(tasks.listTasks("demo", 10).length, 1, "a refused claim wrote a second row");
    assert.deepEqual(proxy.aliases(), ["titanbot-demo-code-t1"], "a second key was minted under one alias");
  } finally { await proxy.close(); store.close(); }
});

test("a workspace and a bot and a task have to be named", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    for (const body of [{ slug: "", agentId: "a", taskId: "t" }, { slug: "demo", agentId: "", taskId: "t" }, { slug: "demo", agentId: "a", taskId: "" }]) {
      const answer = await tasks.openTask(body);
      assert.equal(answer.ok, false);
      assert.equal(answer.error, "bad_request");
    }
    assert.equal(tasks.listTasks("demo", 10).length, 0);
  } finally { await proxy.close(); store.close(); }
});

// ---- the caps --------------------------------------------------------------------------------------

test("a third task while two are running is refused, and the refusal says two in words", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    assert.equal(tasks.settings("demo").concurrent, 2);
    assert.equal((await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" })).ok, true);
    assert.equal((await tasks.openTask({ slug: "demo", agentId: "a_books", taskId: "t2" })).ok, true);

    const over = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t3" });
    assert.equal(over.ok, false);
    assert.equal(over.error, "rate_limited");
    assert.equal(over.scope, "concurrent");
    assert.equal(over.cap, 2);
    // The sentence a bot reads out to a person: plain words, the number spelled, and it says that
    // nothing was started so nobody goes looking for a task that does not exist.
    assert.equal(over.message, "This workspace already has two coding tasks running, so nothing was started. Try again when one finishes.");
    assert.equal(tasks.listTasks("demo", 10).length, 2, "a refused claim wrote a row");
    assert.equal(proxy.aliases().length, 2, "a refused claim minted a credential");

    // Another workspace is untouched: the cap is per workspace.
    assert.equal((await tasks.openTask({ slug: "titanium", agentId: "t_titan", taskId: "t9" })).ok, true);

    // And a slot comes back when one finishes.
    await tasks.closeTask({ id: 1, outcome: "done", minutes: 2 });
    assert.equal((await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t4" })).ok, true);
  } finally { await proxy.close(); store.close(); }
});

test("the twenty-first task in a day is refused, and the window moves on", async () => {
  const proxy = await startMintProxy();
  const clock = clockFrom(Date.parse("2026-09-09T08:00:00Z"));
  const { store, tasks } = ledgerOn(proxy, { now: clock.now });
  try {
    assert.equal(tasks.settings("demo").daily, 20);
    for (let n = 0; n < 20; n += 1) {
      const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: `t${n}` });
      assert.equal(opened.ok, true, `task ${n + 1} of 20`);
      await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 1 });
      clock.advance(60_000);
    }
    const over = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t20" });
    assert.equal(over.ok, false);
    assert.equal(over.scope, "daily");
    assert.equal(over.cap, 20);
    assert.match(over.message, /twenty coding tasks for today, so nothing was started/);
    assert.equal(tasks.listTasks("demo", 100).length, 20);

    // A day later the window has moved, which makes it a window and not a ban.
    clock.advance(24 * 60 * 60_000);
    assert.equal((await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t21" })).ok, true);
  } finally { await proxy.close(); store.close(); }
});

test("every cap and every limit is a setting, globally and per workspace, and a typo uncaps nobody", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    assert.equal(tasks.settings("demo").capUsd, 2);
    store.setSetting("code.capUsd", "5", "a test");
    assert.equal(tasks.settings("demo").capUsd, 5);
    store.setSetting("code.capUsd.demo", "0.25", "a test");
    assert.equal(tasks.settings("demo").capUsd, 0.25, "the per-workspace name wins");
    assert.equal(tasks.settings("titanium").capUsd, 5, "and nobody else moved");

    // A row that is not a positive number falls back rather than taking a limit off: a typo in a
    // settings row must never be the thing that uncaps a coding agent.
    store.setSetting("code.capUsd.demo", "not a number", "a test");
    assert.equal(tasks.settings("demo").capUsd, 5);
    store.setSetting("code.capUsd.demo", "-3", "a test");
    assert.equal(tasks.settings("demo").capUsd, 5);
    store.setSetting("code.capUsd", "0", "a test");
    assert.equal(tasks.settings("demo").capUsd, CODE_DEFAULTS.capUsd, "a zero cap is a typo and not a ban on spending");

    // The same shape on every other number, and on the provider.
    store.setSetting("code.concurrent.demo", "4", "a test");
    assert.equal(tasks.settings("demo").concurrent, 4);
    store.setSetting("code.provider.demo", "e2b", "a test");
    assert.equal(tasks.settings("demo").provider, "e2b");
    store.setSetting("code.provider.demo", "something-else", "a test");
    assert.equal(tasks.settings("demo").provider, CODE_DEFAULTS.provider, "an unknown provider falls back to the local one");

    // And the operator's own workspace gets the same numbers as a customer: a cap that exempted him
    // would hide its own bugs from the only person who would notice.
    assert.equal(tasks.settings("titanium").concurrent, CODE_DEFAULTS.concurrent);
  } finally { await proxy.close(); store.close(); }
});

test("setSettings refuses a provider, a model and a number it does not believe", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    assert.equal(tasks.setSettings({ slug: "demo", provider: "kubernetes" }).ok, false);
    assert.match(tasks.setSettings({ slug: "demo", provider: "kubernetes" }).message, /name one of: local, e2b/);
    // A model that is not one of this system's own plan aliases is a model a task key could not be
    // minted against, so it is refused at the door rather than at the next task.
    assert.equal(tasks.setSettings({ slug: "demo", model: "gpt-5" }).ok, false);
    assert.equal(tasks.setSettings({ slug: "demo", model: "plan-zai-code" }).ok, true);
    assert.equal(tasks.setSettings({ slug: "demo", capUsd: 0 }).ok, false);
    assert.equal(tasks.setSettings({ slug: "demo", capUsd: -1 }).ok, false);
    assert.equal(tasks.setSettings({ slug: "demo", daily: "many" }).ok, false);
    assert.equal(tasks.settings("demo").daily, CODE_DEFAULTS.daily, "a refused write changed something");
  } finally { await proxy.close(); store.close(); }
});

// ---- the rollup the Spend panel draws --------------------------------------------------------------

test("the rollup carries nulls through as counts and never sums them as zero", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    const one = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    await tasks.closeTask({ id: one.id, outcome: "done", minutes: 10 });
    const two = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t2" });
    // A task nobody reported minutes for: the relay died, or it is still running.
    await tasks.closeTask({ id: two.id, outcome: "failed", minutes: null });

    const [row] = tasks.rollup("demo");
    assert.equal(row.slug, "demo");
    assert.equal(row.tasks, 2);
    assert.equal(row.minutes, 10, "an unmeasured task's minutes were summed as a zero");
    assert.equal(row.minutesUnmeasured, 1, "and the count of them is on the row, so a line can say the total is a floor");
    assert.equal(row.spendUsd, 0.02);
    assert.equal(row.spendUnmeasured, 0);
    assert.deepEqual(row.providers, ["local"]);
    assert.equal(row.e2bNote, "");
  } finally { await proxy.close(); store.close(); }
});

test("the operator's own selftest is not one of the customer's tasks on the Spend line", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    // MEASURED ON THE R750 2026-09-10: `code spend` read "demo 8 task(s), 25.6 minute(s)" and one of
    // the eight was `cp-selftest`, the go/no-go verb's own row. The admin Spend panel draws from this
    // same rollup, so engineering's runs were on the line Jason bills a customer from.
    const real = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    await tasks.closeTask({ id: real.id, outcome: "done", minutes: 10 });
    const mine = await tasks.openTask({ slug: "demo", agentId: "cp-selftest", taskId: "selftest-abc" });
    await tasks.closeTask({ id: mine.id, outcome: "selftest", minutes: 0.04 });

    const [row] = tasks.rollup("demo");
    assert.equal(row.tasks, 1, "a selftest must not move the customer's task count");
    assert.equal(row.minutes, 10, "nor its minutes");
    // And the same over every workspace, which is the shape the panel asks for.
    const all = tasks.rollup("");
    assert.equal(all.length, 1);
    assert.equal(all[0].tasks, 1);
    // The detail listing still shows it, because there it is the truth about what ran on the machine.
    assert.ok(tasks.listTasks("demo").some((one) => one.outcome === "selftest"),
      "the selftest row is still in the ledger; only the rollup leaves it out");
  } finally { await proxy.close(); store.close(); }
});

test("a workspace whose every spend was unreadable rolls up to null and not to zero", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    // SUM over nothing but NULLs answers NULL in sqlite, and that is the answer both the panel and
    // the CLI need: "$0.00 across two tasks" and "we could not read either of them" render an inch
    // apart on the same screen and mean opposite things.
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    store.db.exec("UPDATE code_task SET ended_at = '2026-09-09T01:00:00.000Z', outcome = 'done', minutes = NULL, spend_usd = NULL");
    void opened;
    const [row] = tasks.rollup("demo");
    assert.equal(row.spendUsd, null);
    assert.notEqual(row.spendUsd, 0);
    assert.equal(row.spendUnmeasured, 1);
    assert.equal(row.minutesUnmeasured, 1);
    assert.equal(row.minutes, 0, "minutes with nothing measured is a zero TOTAL beside a count of one unmeasured, which the line says out loud");
    // And the rollup over every workspace answers the same row.
    const all = tasks.rollup("");
    assert.equal(all.length, 1);
    assert.equal(all[0].spendUsd, null);
  } finally { await proxy.close(); store.close(); }
});

test("a cloud sandbox task says its model spend is not metered here, rather than drawing a zero", async () => {
  const proxy = await startMintProxy();
  const { store, tasks } = ledgerOn(proxy);
  try {
    tasks.setSettings({ e2bKey: "e2b_planted", actor: "a test" });
    tasks.setSettings({ slug: "demo", provider: "e2b", actor: "a test" });
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 12 });
    const [row] = tasks.rollup("demo");
    assert.equal(row.e2bTasks, 1);
    // THE STRUCTURAL LIMIT, SAID OUT LOUD. An E2B microVM cannot reach titanbot-proxy, so its model
    // calls are on whatever credential the template carries and the dollars are E2B's own bill.
    // Minutes are real; the spend column must not imply it measured something it could not.
    assert.match(row.e2bNote, /not metered through this system/);
  } finally { await proxy.close(); store.close(); }
});

// ---- the table, on a database that has never held it -----------------------------------------------

test("the table appears on a fresh database and on one opened from a file with no code table", async () => {
  const proxy = await startMintProxy();
  try {
    // The fresh case, which is every test above.
    const fresh = memory();
    try {
      const tasks = createCodeTasks({ store: fresh, spendWaitMs: 0, proxy: createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } }) });
      assert.equal((await tasks.openTask({ slug: "demo", agentId: "a", taskId: "t" })).ok, true);
    } finally { fresh.close(); }

    // And the case a fresh store cannot make: the R750's own file, which has held this control
    // plane's tables since long before this wave and has never held code_task. CREATE TABLE IF NOT
    // EXISTS is what makes that work and it is in cp/code.mjs rather than in cp/store.mjs SCHEMA, so
    // this is the test that proves the DDL really runs on open.
    const dir = await mkdtemp(path.join(os.tmpdir(), "cp-code-migrate-"));
    const file = path.join(dir, "control-plane.sqlite");
    const seeded = new DatabaseSync(file);
    seeded.exec("CREATE TABLE admin_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0, actor TEXT NOT NULL DEFAULT '')");
    seeded.close();

    const store = openStore({ file });
    try {
      const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'code_task'").all();
      assert.equal(names.length, 0, "the store's own schema made this table, which it must not");
      const tasks = createCodeTasks({ store, spendWaitMs: 0, proxy: createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } }) });
      const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
      assert.equal(opened.ok, true, "a claim against the new table failed on a database that already existed");
      await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 2 });
      assert.equal(tasks.listTasks("demo", 10)[0].minutes, 2);
      // And twice, because this runs on every open for ever.
      const second = createCodeTasks({ store, spendWaitMs: 0, proxy: createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } }) });
      assert.equal(second.listTasks("demo", 10).length, 1, "the second open lost the rows");
    } finally { store.close(); }
  } finally { await proxy.close(); }
});

// ---- the routes ------------------------------------------------------------------------------------

test("open and close are behind the relay's credential, and the read is behind the super admin's", async () => {
  const proxy = await startMintProxy();
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({
    env: { CP_RELAY_TOKEN: relayToken, CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey },
  });
  try {
    const admin = cp.config.adminToken;
    const claim = { slug: "demo", agentId: "a_titan", taskId: "t1" };

    // The relay's credential, and nothing else, opens the claim. The admin token does not: it adds
    // accounts and deletes services, and neither credential should ever do the other's job.
    assert.equal((await cp.request("POST", "/v1/relay/code/task/open", { body: claim })).status, 401);
    assert.equal((await cp.request("POST", "/v1/relay/code/task/open", { body: claim, token: admin })).status, 401);
    // And the method refusal comes FIRST, so a wrong method charges nobody and learns nothing.
    assert.equal((await cp.request("GET", "/v1/relay/code/task/open", { token: relayToken })).status, 405);

    const opened = await cp.request("POST", "/v1/relay/code/task/open", { body: claim, token: relayToken });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.ok, true);
    assert.equal(opened.body.alias, "titanbot-demo-code-t1");
    assert.equal(opened.body.capUsd, 2);
    assert.equal(opened.body.minutesCap, 30);
    assert.equal(typeof opened.body.key, "string");

    const closed = await cp.request("POST", "/v1/relay/code/task/close", {
      body: { id: opened.body.id, outcome: "done", minutes: 4, detail: "" }, token: relayToken,
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.revoked, true);

    // The operator's read. The relay's own credential does not open it.
    assert.equal((await cp.request("GET", "/v1/code/tasks?slug=demo")).status, 401);
    assert.equal((await cp.request("GET", "/v1/code/tasks?slug=demo", { token: relayToken })).status, 401);
    const listed = await cp.request("GET", "/v1/code/tasks?slug=demo", { token: admin });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rows.length, 1);
    assert.equal(listed.body.rows[0].outcome, "done");
    assert.equal(listed.body.rows[0].minutes, 4);
    assert.equal(listed.body.tenants[0].slug, "demo");
    // NO KEY ON ANY ANSWER BUT THE OPEN. The open hands the credential over once, by design; every
    // read after it carries the alias and never the value.
    assert.equal(listed.text.includes(opened.body.key), false, "the operator's read carried a task credential");
    assert.equal(closed.text.includes(opened.body.key), false, "the close carried the credential back");
  } finally { await cp.dispose(); await proxy.close(); }
});

test("a cap refusal is a 429 the relay can pass on word for word, and a bad claim is a 400", async () => {
  const proxy = await startMintProxy();
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({
    env: { CP_RELAY_TOKEN: relayToken, CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey },
  });
  try {
    const ask = (taskId) => cp.request("POST", "/v1/relay/code/task/open", { body: { slug: "demo", agentId: "a_titan", taskId }, token: relayToken });
    assert.equal((await ask("t1")).status, 200);
    assert.equal((await ask("t2")).status, 200);
    const over = await ask("t3");
    assert.equal(over.status, 429);
    assert.equal(over.body.error, "rate_limited");
    assert.equal(over.body.message, "This workspace already has two coding tasks running, so nothing was started. Try again when one finishes.");

    const bad = await cp.request("POST", "/v1/relay/code/task/open", { body: { slug: "demo" }, token: relayToken });
    assert.equal(bad.status, 400);

    const missing = await cp.request("POST", "/v1/relay/code/task/close", { body: { id: 9999, outcome: "done" }, token: relayToken });
    assert.equal(missing.status, 404);
  } finally { await cp.dispose(); await proxy.close(); }
});

test("a server with no proxy refuses a task in plain words rather than half starting one", async () => {
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    const answer = await cp.request("POST", "/v1/relay/code/task/open", {
      body: { slug: "demo", agentId: "a_titan", taskId: "t1" }, token: relayToken,
    });
    // 502 and not 200, and not a throw: this side could not do its job, which is not the caller's
    // fault and is not a cap.
    assert.equal(answer.status, 502);
    assert.equal(answer.body.error, "no_credential");
    assert.match(answer.body.message, /nothing was started/);
    // And the words a bot reads out name no vendor, no container and no environment variable.
    assert.equal(/CP_PROXY|LiteLLM|litellm|titanbot-proxy/.test(answer.body.message), false, answer.body.message);
  } finally { await cp.dispose(); }
});

test("the settings route is the super admin's and it never hands the cloud sandbox account back", async () => {
  const proxy = await startMintProxy();
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({
    env: { CP_RELAY_TOKEN: relayToken, CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey },
  });
  const planted = `e2b_${randomBytes(12).toString("hex")}`;
  try {
    assert.equal((await cp.request("POST", "/v1/code/settings", { body: { slug: "demo", provider: "e2b" } })).status, 401);
    assert.equal((await cp.request("POST", "/v1/code/settings", { body: { slug: "demo", provider: "e2b" }, token: relayToken })).status, 401);
    assert.equal((await cp.request("GET", "/v1/code/settings", { token: cp.config.adminToken })).status, 405);

    const written = await cp.admin("POST", "/v1/code/settings", { slug: "demo", capUsd: 1.5, concurrent: 3 });
    assert.equal(written.status, 200);
    assert.equal(written.body.settings.capUsd, 1.5);
    assert.equal(written.body.settings.concurrent, 3);

    const keyed = await cp.admin("POST", "/v1/code/settings", { e2bKey: planted });
    assert.equal(keyed.status, 200);
    assert.equal(keyed.body.settings.e2bKeySet, true);
    assert.equal(keyed.text.includes(planted), false, "the settings write echoed the account back");

    const read = await cp.request("GET", "/v1/code/tasks", { token: cp.config.adminToken });
    assert.equal(read.status, 200);
    assert.equal(read.text.includes(planted), false, "the operator's read carried the cloud sandbox account");
    assert.equal(read.body.settings.e2bKeySet, true);

    const refused = await cp.admin("POST", "/v1/code/settings", { slug: "demo", provider: "kubernetes" });
    assert.equal(refused.status, 400);
  } finally { await cp.dispose(); await proxy.close(); }
});

// ---- the Spend panel's one additive line -----------------------------------------------------------

test("the Spend panel reads the coding ledger and has words for a read that failed", async () => {
  const cp = await startControlPlane({});
  try {
    const script = await cp.request("GET", "/admin/admin.js");
    assert.equal(script.status, 200);
    assert.ok(script.text.includes('api("GET", "/v1/code/tasks")'), "the Spend panel does not read the coding ledger");
    // THE PANEL'S OWN HONESTY RULE. A read that failed says so in words; it does not draw a zero and
    // it does not leave a silent gap where minutes should be.
    assert.ok(script.text.includes("Sandbox minutes not measured"), "the console has no words for a coding read that failed");
    assert.ok(script.text.includes("spend not measured"), "the console has no words for a task whose key could not be asked about");
    assert.ok(script.text.includes("not metered through this system") || script.text.includes("e2bNote"),
      "the console cannot say that a cloud sandbox's model spend is not metered here");
    // And it never coerces either figure to a number, which is how a missing one becomes a zero.
    assert.equal(/spendUsd\s*\)\s*\|\|\s*0/.test(script.text), false, "the console coerces a missing coding spend to zero");
    assert.equal(/row\.minutes\s*\|\|\s*0/.test(script.text), false, "the console coerces missing coding minutes to zero");

    // NO SEVENTH COLUMN, which is what keeps cp/admin/index.html and the literal 6 in rowSpanning out
    // of this wave. The line lives in the Client cell.
    const page = await cp.request("GET", "/admin");
    assert.equal(page.status, 200);
    assert.ok(script.text.includes('rowSpanning(6, "No customers yet.")'), "the Spend table's column count moved");

    // And the panel loader count is untouched: this is a second fetch inside an existing panel, not
    // a new panel, so the live flag and the refresh must still agree.
    const declared = /window\.__adminLive = \{ panels: (\d+)/.exec(script.text);
    const loaders = /Promise\.allSettled\(\[([^\]]*)\]\)/.exec(script.text);
    assert.ok(declared != null && loaders != null);
    assert.equal(Number(declared[1]), loaders[1].split(",").filter((call) => call.trim().length > 0).length);
  } finally { await cp.dispose(); }
});
