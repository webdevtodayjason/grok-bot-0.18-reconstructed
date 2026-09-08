// ADMIN-1: the two reads the control plane makes against this relay.
//
// GET /admin/login-attempts and GET /admin/boxes are the only routes on this relay that answer
// before a console session, other than the job bus and the mail webhook. They exist because the
// super admin console lives on the control plane and these two facts do not: the sign-in ledger is
// written at THIS door, and box health needs the docker socket the control plane deliberately has
// no access to.
//
// That makes them worth their own file. An unauthenticated route that serves a record of who tried
// to sign in is exactly the thing that has to be held to a credential, and the claim underneath all
// of it is one sentence: whatever a stranger typed into the password box is not in the answer and
// is not on the disk.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { LEDGER_NAME, readLedgerFile } from "../ui/login-ledger.mjs";
import { RELAY_PASSWORD, RELAY_TOKEN, form, startRelay, tenantsFile } from "./relay-tenant-support.mjs";

// A password no source file in this repo contains, so finding it on disk can only mean the ledger
// wrote it. That is the whole point of the string.
const TRIED = "correct-horse-battery-staple-9471";

// A control plane URL and token, so relayConfig() is not null and the route has something to
// compare against; a tenants file so the registry never reaches for a network that is not there.
const withControlPlane = {
  CP_URL: "http://127.0.0.1:1",
  CP_RELAY_TOKEN: RELAY_TOKEN,
  SAND_UI_TENANTS_FILE: tenantsFile([]),
};

const rowsOn = (relay) => readLedgerFile(path.join(relay.dir, LEDGER_NAME));

/**
 * Every ledger row is appended AFTER its own response has gone back on the wire, so reading the
 * ledger the instant a response lands is a race. Both cases below hit it: they passed when the file
 * ran alone and failed under `npm test`, where a dozen suites share the machine. These two helpers
 * wait for the row the case is actually about, up to a bounded time, and then hand back whatever
 * arrived so the assertion still reports a real regression as a real regression rather than as a
 * timeout.
 */
const settleWait = async (read, done, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const rowsOnceLocked = (relay) => settleWait(
  () => rowsOn(relay),
  (rows) => rows.some((row) => row.outcome === "locked"),
);

// The admin route's body, once its rows carry what the case is about. The 200 is asserted on every
// poll, so a route that starts refusing fails here rather than after the wait.
const waitForRows = (fetchBody, done) => settleWait(
  async () => {
    const response = await fetchBody();
    assert.equal(response.status, 200);
    return await response.json();
  },
  (body) => done(body.rows ?? []),
);

// Everything the relay wrote into its own directory, as one string. This is the "grep the data
// directory for the password" check, done in process.
function everythingWritten(relay) {
  return readdirSync(relay.dir)
    .filter((name) => !name.endsWith(".mjs"))
    .map((name) => { try { return readFileSync(path.join(relay.dir, name), "utf8"); } catch { return ""; } })
    .join("\n");
}

test("only CP_RELAY_TOKEN opens the ledger, and what it opens holds no password", async () => {
  const relay = await startRelay(withControlPlane, { prefix: "relay-admin-ledger-" });
  try {
    const read = (init) => fetch(`${relay.base}/admin/login-attempts`, init);

    // Not a console route and not a bus route: no method but GET, and the refusal comes before any
    // credential is looked at, so it charges nobody's lockout.
    assert.equal((await read({ method: "POST" })).status, 405);
    assert.equal((await read({})).status, 401, "no credential is no answer");
    assert.equal((await read({ headers: { authorization: `Bearer ${RELAY_TOKEN}x` } })).status, 401,
      "a credential that is nearly right is still no answer");

    // A refused sign-in on the instance door, and one that works, so both kinds of row exist.
    await fetch(`${relay.base}/login`, form({ password: TRIED }));
    await fetch(`${relay.base}/login`, form({ password: RELAY_PASSWORD }));

    // Both rows are appended after their /login response has already gone back on the wire, so
    // reading the route once is a race: this case passed alone and failed under `npm test`, where a
    // dozen suites share the machine. Wait for the two rows this case is about, and let the
    // assertions below report what did arrive when the wait runs out.
    const body = await waitForRows(
      () => read({ headers: { authorization: `Bearer ${RELAY_TOKEN}` } }),
      (rows) => rows.some((row) => row.outcome === "refused" && row.door === "instance")
        && rows.some((row) => row.outcome === "ok"),
    );
    assert.equal(body.source, "relay");
    assert.match(body.measuredAt, /^\d{4}-\d\d-\d\dT/, "every number carries when it was measured");

    const refused = body.rows.find((row) => row.outcome === "refused" && row.door === "instance");
    assert.notEqual(refused, undefined, `no refused row in ${JSON.stringify(body.rows)}`);
    assert.match(refused.triedHash, /^[0-9a-f]{64}$/, "the try is recorded as a digest");
    assert.equal(refused.ip.length > 0, true, "with the address that sent it");

    const ok = body.rows.find((row) => row.outcome === "ok");
    assert.notEqual(ok, undefined, "a sign-in that worked is recorded too");
    // The row shape is fixed and absent reads as empty, so a reader never has to ask whether a key
    // is missing or the value is. A sign-in that worked keeps no shadow of the password.
    assert.equal(ok.triedHash, "", "with no digest");

    // The claim, checked against the bytes: not in the answer, not in any file the relay wrote.
    assert.equal(JSON.stringify(body).includes(TRIED), false, "the answer carries no password");
    assert.equal(everythingWritten(relay).includes(TRIED), false, "and neither does anything on disk");
  } finally { relay.stop(); }
});

test("a lockout is a row of its own, and five wrong passwords are five digests", async () => {
  const relay = await startRelay(withControlPlane, { prefix: "relay-admin-lock-" });
  try {
    // Five wrong passwords is the lockout; the sixth attempt is turned away before the body is
    // even read, which is the row that proves the address kept knocking after it was told to stop.
    for (let n = 0; n < 5; n += 1) await fetch(`${relay.base}/login`, form({ password: `${TRIED}-${n}` }));
    assert.equal((await fetch(`${relay.base}/login`, form({ password: TRIED }))).status, 429);

    // Read off disk rather than through the route: this address is locked out of that door too,
    // which is itself the point -- the control plane reads from its own address on titanbot-net.
    const rows = await rowsOnceLocked(relay);
    const lockRow = rows.find((row) => row.outcome === "locked");
    assert.notEqual(lockRow, undefined, `no locked row in ${JSON.stringify(rows)}`);
    assert.equal(lockRow.ip.length > 0, true);
    assert.equal(lockRow.triedHash, "", "there is no password to hash before the body is read");

    // Five different wrong passwords, five different digests: this is the question the panel asks.
    const digests = new Set(rows.filter((row) => row.triedHash.length > 0).map((row) => row.triedHash));
    assert.equal(digests.size, 5, `five different passwords should be five digests, got ${digests.size}`);
    assert.equal(everythingWritten(relay).includes(TRIED), false, "and none of the five is on disk");
  } finally { relay.stop(); }
});

test("box health answers the same credential and nothing else", async () => {
  const relay = await startRelay(withControlPlane, { prefix: "relay-admin-boxes-" });
  try {
    assert.equal((await fetch(`${relay.base}/admin/boxes`)).status, 401);
    const response = await fetch(`${relay.base}/admin/boxes`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Array.isArray(body.boxes), true, `boxes should be a list, got ${JSON.stringify(body)}`);
    assert.match(body.measuredAt, /^\d{4}-\d\d-\d\dT/, "every number carries when it was measured");
  } finally { relay.stop(); }
});

test("neither route exists when this console has no control plane", async () => {
  // No CP_RELAY_TOKEN means there is no credential to compare against and nobody to ask. The route
  // does not exist on this install, and 404 is the truthful shape rather than a 401 that implies
  // there is a right answer somewhere.
  const relay = await startRelay({}, { prefix: "relay-admin-solo-" });
  try {
    assert.equal((await fetch(`${relay.base}/admin/login-attempts`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${relay.base}/admin/boxes`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).status, 404);
  } finally { relay.stop(); }
});
