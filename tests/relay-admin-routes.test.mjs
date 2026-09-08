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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { LEDGER_NAME, readLedgerFile } from "../ui/login-ledger.mjs";
import { RELAY_PASSWORD, RELAY_TOKEN, form, startRelay, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";
import { boxStub, includedSet } from "./relay-proxy-support.mjs";

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


// ---- PROXY-1: the migration's two doors --------------------------------------------------------
//
// These are the routes the control plane drives the migration through, and they are on this relay
// for the same reason the two reads above are: writing inside a box needs the docker socket, and
// the control plane's container deliberately has none.
//
// What makes them worth their own cases is not that they work. It is that the whole security claim
// of this wave -- "the copied operator key is gone from that box" -- is a claim these routes make,
// and a route that answers with a key would be a route that hands the thing it is proving absent
// to whoever asked. So: names, lengths and twelve hex characters of a sha256, and nothing else.

const OPERATOR_KEY = "an-operator-provider-key-copied-into-every-box";
const OPERATOR_TINYFISH = "an-operator-tinyfish-key-copied-the-same-way";
const sha12 = (value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

// One customer, one box that is a directory on this Mac, one included set.
async function startMigrationConsole() {
  const demo = tenantRow("demo");
  const stub = boxStub([demo.row.box]);
  const included = includedSet({ key: "sk-virtual-for-demo" });
  // Exactly what the R750 boxes hold today: one copied operator provider key in the endpoint pin,
  // and the same operator's TinyFish key in the connector store.
  stub.writeSecrets(demo.row.box, {
    SAND_OPENAI_COMPATIBLE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    SAND_OPENAI_COMPATIBLE_MODEL: "qwen3.8-max",
    SAND_OPENAI_COMPATIBLE_API_KEY: OPERATOR_KEY,
    SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "Qwen",
    CODERABBIT_API_KEY: "a shell credential that is the customer's own",
  });
  stub.writeConnectorSecrets(demo.row.box, {
    servers: { tinyfish: { TINYFISH_API_KEY: OPERATOR_TINYFISH }, other: { OTHER_KEY: "not the one" } },
    shell: { CODERABBIT_API_KEY: "a shell credential that is the customer's own" },
  });
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1",
    CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([{ ...demo.row, included }]),
    ...stub.env,
  }, { prefix: "relay-admin-migrate-", pathValue: stub.pathValue });
  return { relay, demo, stub, box: demo.row.box };
}

const post = (relay, url, body, init = {}) => fetch(`${relay.base}${url}`, {
  method: "POST", headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  body: JSON.stringify(body ?? {}),
});
const asAdmin = (relay, url, body) => post(relay, url, body, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });

test("all three migration doors answer only CP_RELAY_TOKEN, and only POST", async () => {
  const { relay } = await startMigrationConsole();
  try {
    for (const step of ["use-included", "forget-provider-keys", "rollback-included"]) {
      const path = `/admin/tenants/demo/${step}`;
      // The method refusal still comes before the credential, so a wrong method charges nobody's
      // lockout and learns nothing about whether the route is there.
      assert.equal((await fetch(`${relay.base}${path}`)).status, 405, `${step} is POST-only`);
      assert.equal((await post(relay, path, {})).status, 401, `${step} without a credential`);
      assert.equal((await post(relay, path, {}, { headers: { authorization: `Bearer ${RELAY_TOKEN}x` } })).status, 401,
        `${step} with a credential that is nearly right`);
      // And a console session is not a credential for this door: it is not even a console route.
      const signedIn = await fetch(`${relay.base}/login`, form({ password: RELAY_PASSWORD }));
      const cookie = /(?:^|,\s*)(gb_session=[^;]+)/.exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? "";
      assert.equal((await post(relay, path, {}, { headers: { cookie } })).status, 401, `${step} with a console cookie`);
    }
    // A workspace this console does not serve is a plain sentence, not a stack trace.
    assert.equal((await asAdmin(relay, "/admin/tenants/nobody/use-included", {})).status, 404);
  } finally { relay.stop(); }
});

test("use-included points the box at a plan model, keeps the way back, and answers with no key", async () => {
  const { relay, demo, stub, box } = await startMigrationConsole();
  try {
    const res = await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-zai" });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const body = JSON.parse(raw);
    assert.equal(body.slug, "demo");
    assert.match(body.measuredAt, /^\d{4}-\d\d-\d\dT/, "every number carries when it was measured");
    assert.equal(body.using, "plan-zai");

    // Names, lengths and hash prefixes. Not the key, not on any field, not anywhere in the answer.
    assert.equal(raw.includes("sk-virtual-for-demo"), false, "the answer must not carry the virtual key");
    const wrote = new Map(body.wrote.map((entry) => [entry.name, entry]));
    assert.equal(wrote.get("SAND_OPENAI_COMPATIBLE_API_KEY").length, "sk-virtual-for-demo".length);
    assert.equal(wrote.get("SAND_OPENAI_COMPATIBLE_API_KEY").sha256, sha12("sk-virtual-for-demo"));
    assert.equal(wrote.get("SAND_OPENAI_COMPATIBLE_SERVED_BY").sha256, sha12("Z.AI"));

    const secrets = stub.secretsOf(box);
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_API_KEY, "sk-virtual-for-demo");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_MODEL, "plan-zai");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_SERVED_BY, "Z.AI");
    assert.equal(secrets.CODERABBIT_API_KEY, "a shell credential that is the customer's own",
      "the other credential plane in this file survives the switch");
    assert.equal(statSync(stub.fileOf(box, "box-secrets.json")).mode & 0o777, 0o600);

    // The way back, written BEFORE the switch and at 0600. From the moment the copied operator key
    // leaves this box the proxy is the only thing answering for it, so a rollback that depends on
    // remembering what was there is not a rollback.
    const rollback = path.join(demo.profile, "model-proxy-rollback.json");
    assert.equal(body.rollbackFile, rollback);
    assert.equal(statSync(rollback).mode & 0o777, 0o600);
    const kept = JSON.parse(readFileSync(rollback, "utf8")).secrets;
    assert.equal(kept.SAND_OPENAI_COMPATIBLE_API_KEY, OPERATOR_KEY, "the snapshot is what was there before");
    assert.equal(kept.SAND_OPENAI_COMPATIBLE_MODEL, "qwen3.8-max");

    // A model that is not in the plan is a plain refusal, not a half-done switch.
    assert.equal((await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-nothing" })).status, 404);
  } finally { relay.stop(); }
});

test("rollback-included puts the box back from the snapshot, and refuses when there is nothing to replay", async () => {
  const { relay, stub, box, demo } = await startMigrationConsole();
  try {
    // Nothing to replay is a plain sentence and no write at all. A box that was never moved onto a
    // plan must not be "restored" into some default somebody guessed at.
    const early = await asAdmin(relay, "/admin/tenants/demo/rollback-included", {});
    assert.equal(early.status, 409, await early.text());
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_API_KEY, OPERATOR_KEY, "a refused rollback wrote something");

    await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-zai" });
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_MODEL, "plan-zai");

    const res = await asAdmin(relay, "/admin/tenants/demo/rollback-included", {});
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const body = JSON.parse(raw);
    assert.equal(body.restoredFrom, path.join(demo.profile, "model-proxy-rollback.json"));
    // Names, lengths and hash prefixes on the way out, the same as every other door here.
    assert.equal(raw.includes(OPERATOR_KEY), false, "the answer must not carry the key it put back");
    assert.equal(raw.includes("sk-virtual-for-demo"), false);

    // The box is byte for byte what it was before the switch, and still 0600.
    const back = stub.secretsOf(box);
    assert.equal(back.SAND_OPENAI_COMPATIBLE_API_KEY, OPERATOR_KEY);
    assert.equal(back.SAND_OPENAI_COMPATIBLE_MODEL, "qwen3.8-max");
    assert.equal(Object.hasOwn(back, "SAND_OPENAI_COMPATIBLE_SERVED_BY"), false,
      "plan wording must not survive a rollback onto the customer's own key");
    assert.equal(statSync(stub.fileOf(box, "box-secrets.json")).mode & 0o777, 0o600);
  } finally { relay.stop(); }
});

test("forget-provider-keys deletes only the hash it was given, in all three places, and leaves both files valid", async () => {
  const { relay, stub, box, demo } = await startMigrationConsole();
  try {
    // A row of the customer's own carrying the same copied key, which is the third place it landed.
    const catalog = path.join(demo.state, "endpoints.json");
    writeFileSync(catalog, JSON.stringify({ endpoints: [
      { id: "qwen", name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-max", apiKey: OPERATOR_KEY },
      { id: "mine", name: "my own", baseUrl: "https://93.184.216.34/v1", model: "m", apiKey: "a key the customer owns" },
    ] }, null, 2));

    // A prefix that matches nothing removes nothing, which is what makes a typo safe.
    const nothing = JSON.parse(await (await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: "0123456789ab" })).text());
    assert.equal(nothing.removedCount, 0);
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_API_KEY, OPERATOR_KEY);

    // A value rather than a hash is refused: this route never accepts a credential.
    assert.equal((await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: OPERATOR_KEY })).status, 400);
    assert.equal((await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: "abc" })).status, 400);

    const res = await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: sha12(OPERATOR_KEY) });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const body = JSON.parse(raw);
    assert.equal(raw.includes(OPERATOR_KEY), false, "the answer must not carry what it deleted");
    assert.deepEqual(body.removed.map((entry) => `${entry.file}:${entry.name}`).sort(), [
      "box-secrets.json:SAND_OPENAI_COMPATIBLE_API_KEY",
      "endpoints.json:qwen.apiKey",
    ]);
    for (const entry of body.removed) assert.equal(entry.sha256, sha12(OPERATOR_KEY));
    for (const entry of body.removed) assert.equal(entry.length, OPERATOR_KEY.length);

    // The absence proof. The migration is judged on what is LEFT in the box, not on a removal
    // count, so the answer lists every credential still there by name, length and hash prefix, and
    // the hash that was asked for is not among them.
    assert.equal(body.remaining.some((entry) => entry.sha256 === sha12(OPERATOR_KEY)), false,
      "the hash that was removed is still being reported as present");
    assert.equal(body.remaining.some((entry) => entry.where === "connector-env-secrets.json"
      && entry.sha256 === sha12(OPERATOR_TINYFISH)), true,
      "a credential this call was not asked about must still be reported as present");
    assert.equal(raw.includes(OPERATOR_TINYFISH), false, "the remaining list must carry no value either");

    // Gone from the box, and nothing else went with it.
    const secrets = stub.secretsOf(box);
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_API_KEY, undefined);
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_BASE_URL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(secrets.CODERABBIT_API_KEY, "a shell credential that is the customer's own");
    assert.equal(statSync(stub.fileOf(box, "box-secrets.json")).mode & 0o777, 0o600);

    // The customer's ROW survives with its key cleared: the row is their configuration, the key is
    // the operator's. Their own key on their own row is untouched.
    const written = JSON.parse(readFileSync(catalog, "utf8"));
    assert.deepEqual(written.endpoints.map((r) => r.id), ["qwen", "mine"]);
    assert.equal(written.endpoints[0].apiKey, "");
    assert.equal(written.endpoints[1].apiKey, "a key the customer owns");
    assert.equal(readFileSync(catalog, "utf8").includes(OPERATOR_KEY), false);

    // And the connector store, which is the same operator's TinyFish key under its own name.
    const tinyfish = await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: sha12(OPERATOR_TINYFISH) });
    const tinyfishBody = JSON.parse(await tinyfish.text());
    assert.deepEqual(tinyfishBody.removed.map((entry) => `${entry.file}:${entry.name}`), [
      "connector-env-secrets.json:servers.tinyfish.TINYFISH_API_KEY",
    ]);
    const connectors = stub.connectorSecretsOf(box);
    assert.deepEqual(connectors.servers.tinyfish, {}, "the file stays present and valid");
    assert.equal(connectors.servers.other.OTHER_KEY, "not the one", "another connector's value is not touched");
    assert.equal(connectors.shell.CODERABBIT_API_KEY, "a shell credential that is the customer's own",
      "and neither is the shell section");
    assert.equal(statSync(stub.fileOf(box, "connector-env-secrets.json")).mode & 0o777, 0o600);
  } finally { relay.stop(); }
});

test("no migration door exists when this console has no control plane", async () => {
  const relay = await startRelay({}, { prefix: "relay-admin-migrate-solo-" });
  try {
    for (const step of ["use-included", "forget-provider-keys", "rollback-included"]) {
      const res = await fetch(`${relay.base}/admin/tenants/demo/${step}`, {
        method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/json" }, body: "{}",
      });
      assert.equal(res.status, 404, `${step} should not exist without a control plane`);
    }
  } finally { relay.stop(); }
});

test("a second migration keeps the first way back instead of overwriting it with a plan state", async () => {
  const { relay, stub, box, demo } = await startMigrationConsole();
  const rollback = path.join(demo.profile, "model-proxy-rollback.json");
  try {
    // MEASURED ON THE R750 2026-09-08, which is why this case exists. demo was migrated twice
    // inside a minute while a re-mint hazard was being fixed. The first run saved the true
    // pre-migration state; the second run saved what the first had left, a REVOKED virtual key
    // pointed at the proxy. `proxy rollback demo` would have written that back into the box and
    // taken the tenant off the air while reporting success.
    const first = JSON.parse(await (await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-zai" })).text());
    assert.equal(first.rollback, "written");
    const saved = readFileSync(rollback, "utf8");
    assert.equal(JSON.parse(saved).secrets.SAND_OPENAI_COMPATIBLE_API_KEY, OPERATOR_KEY);

    const second = JSON.parse(await (await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-minimax" })).text());
    assert.equal(second.rollback, "kept", "a second migration overwrote the way back");
    assert.equal(readFileSync(rollback, "utf8"), saved, "the snapshot changed under a second migration");

    // And the rollback still lands on what the box actually had, not on the plan.
    await asAdmin(relay, "/admin/tenants/demo/rollback-included", {});
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_API_KEY, OPERATOR_KEY);
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_MODEL, "qwen3.8-max");
  } finally { relay.stop(); }
});

test("a box already on the plan records no way back rather than recording the plan as one", async () => {
  const { relay, stub, box, demo } = await startMigrationConsole();
  const rollback = path.join(demo.profile, "model-proxy-rollback.json");
  try {
    // titanium's shape on the R750: a workspace pointed at the proxy with no snapshot beside it.
    // The old code would have taken one here, and the thing it recorded would have been the plan.
    stub.writeSecrets(box, {
      SAND_OPENAI_COMPATIBLE_BASE_URL: "http://titanbot-proxy:4000/v1",
      SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai",
      SAND_OPENAI_COMPATIBLE_API_KEY: "sk-virtual-for-demo",
    });
    const body = JSON.parse(await (await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-zai" })).text());
    assert.equal(body.rollback, "none");
    assert.throws(() => readFileSync(rollback, "utf8"), "a plan state was written as the way back");
    // And the door says so plainly rather than restoring something invented.
    assert.equal((await asAdmin(relay, "/admin/tenants/demo/rollback-included", {})).status, 409);
  } finally { relay.stop(); }
});

test("forget-provider-keys reaches the box's own store, and names what it will not delete", async () => {
  const { relay, stub, box } = await startMigrationConsole();
  try {
    // The blob the first absence proof missed. MEASURED ON THE R750 2026-09-08: box-store-sync had
    // copied box-secrets.json into the box's content-addressed store, so a byte-identical copy of
    // the operator's key sat at /var/lib/sand-box-store/<id>/blobs/<sha>, mode 0644 root:root, in
    // every one of the three boxes -- and the agent host runs as root inside the box. The removal
    // read three files and reported the key absent while it was still there.
    const blob = stub.writeStoreFile(box, "store-1/blobs/aaaa", JSON.stringify({ version: 1, secrets: {
      SAND_OPENAI_COMPATIBLE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      SAND_OPENAI_COMPATIBLE_MODEL: "qwen3.8-max",
      SAND_OPENAI_COMPATIBLE_API_KEY: OPERATOR_KEY,
    } }));
    // And something that is NOT a secrets document but carries the same bytes: a pack, a
    // conversation database, an audit log. Deleting one of these to chase a credential is the
    // customer's data gone, so it is named and left where it is.
    const pack = stub.writeStoreFile(box, "store-1/packs/pack-1", `some packed bytes ${OPERATOR_KEY} and more`);

    const raw = await (await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: sha12(OPERATOR_KEY) })).text();
    const body = JSON.parse(raw);
    assert.equal(raw.includes(OPERATOR_KEY), false, "the answer must not carry what it swept for");
    assert.equal(body.storeSwept, true);
    assert.equal(body.removed.some((entry) => entry.file === "box-store" && entry.name === blob), true,
      "the stored copy of box-secrets.json was not removed");
    assert.throws(() => readFileSync(blob, "utf8"), "the blob is still on disk");
    assert.equal(body.storeCarrying, 1);
    assert.equal(body.remaining.some((entry) => entry.where === "box-store" && entry.name === pack), true,
      "a store file that still carries the value has to be named");
    assert.equal(readFileSync(pack, "utf8").includes(OPERATOR_KEY), true, "an unrelated store file was deleted");
  } finally { relay.stop(); }
});

test("a second forget still sweeps the store when the three files are already clean", async () => {
  const { relay, stub, box } = await startMigrationConsole();
  try {
    // The PROXY-7 shape: the live files were cleaned by an earlier run, so there is no value left
    // to grep the store with. Found by SHAPE instead, which is why the sweep parses candidates
    // rather than trusting what the three files happen to still hold.
    stub.writeSecrets(box, { SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai" });
    const blob = stub.writeStoreFile(box, "store-1/blobs/bbbb",
      JSON.stringify({ servers: { tinyfish: { TINYFISH_API_KEY: OPERATOR_TINYFISH } } }));

    const body = JSON.parse(await (await asAdmin(relay, "/admin/tenants/demo/forget-provider-keys", { prefix: sha12(OPERATOR_TINYFISH) })).text());
    assert.equal(body.removed.some((entry) => entry.file === "box-store" && entry.name === blob), true);
    assert.throws(() => readFileSync(blob, "utf8"));
  } finally { relay.stop(); }
});
