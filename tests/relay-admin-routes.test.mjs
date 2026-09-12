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
import http from "node:http";
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

/**
 * One wrong password sent with NO user agent header of any kind.
 *
 * It has to be node's raw http rather than fetch, and that is the whole reason it exists: measured
 * on this Mac, `fetch` with no headers still sends `user-agent: node`, and only `http.request`
 * sends none. Those are the two shapes the live ledger actually holds, and the case above needs
 * both to be able to say the panel's rule can never be an absence test.
 */
const knockWithNoAgentHeader = (base, password) => new Promise((resolve, reject) => {
  const url = new URL("/login", base);
  const body = new URLSearchParams({ password }).toString();
  const request = http.request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      "content-length": Buffer.byteLength(body),
    },
  }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
  request.on("error", reject);
  request.end(body);
});

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
    // The read itself never waits for health work. On a fresh relay it starts the first background
    // sweep and may therefore have no completed fleet stamp yet; the next read sees the empty-fleet
    // sweep completed.
    const swept = body.measuredAt == null
      ? await settleWait(
        async () => (await fetch(`${relay.base}/admin/boxes`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).json(),
        (answer) => answer.measuredAt != null,
      )
      : body;
    assert.match(swept.measuredAt, /^\d{4}-\d\d-\d\dT/, "the completed fleet sweep says when it ran");
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
//
// PROVIDERS-1. The set carries a label on plan-zai and none on the others, because both are real
// states and the super admin's door has to be honest about each. A named model is what the panel
// produces once an operator has named it; an unnamed one is every plan model on the R750 today.
// The label is added here rather than in the shared includedSet so this file can say what the
// SUPER ADMIN's door answers without moving what every other suite measures.
async function startMigrationConsole() {
  const demo = tenantRow("demo");
  const stub = boxStub([demo.row.box]);
  const base = includedSet({ key: "sk-virtual-for-demo" });
  const included = {
    ...base,
    models: base.models.map((row) => (row.id === "plan-zai" ? { ...row, modelLabel: "GLM-5.3" } : row)),
  };
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

    // PROVIDERS-1. The two things the super admin needs back from this door and could not get
    // before, both about what the customer will experience rather than about the write succeeding.
    //
    // The LABEL, because it is what that customer's own Titan will tell them it is running. A door
    // that reports a successful switch while the box goes on naming a routing alias is the failure
    // this wave exists to end, and the operator has to be able to read the name back without
    // opening the customer's console.
    assert.equal(body.modelLabel, "GLM-5.3");
    assert.equal(wrote.get("SAND_OPENAI_COMPATIBLE_MODEL_LABEL").sha256, sha12("GLM-5.3"));
    // The PIN, because a box whose container carries SAND_OPENAI_COMPATIBLE_* keeps answering
    // through that env whatever this door writes into the file. This box is a directory on this
    // Mac with no container behind it, so the honest answer is false and no reason -- not knowing
    // is a different answer from knowing it is unpinned, and both callers refuse without docker.
    assert.equal(body.pinned, false);
    assert.equal(body.pinnedBy, null);

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

    // A plan model nobody has named answers with no label AND takes the last one back out of the
    // box. A stale label is worse than none: the box would go on confidently telling its customer
    // it runs a model it no longer runs, which is the same quiet lie in a different place.
    const unnamed = JSON.parse(await (await asAdmin(relay, "/admin/tenants/demo/use-included", { model: "plan-minimax" })).text());
    assert.equal(unnamed.modelLabel, "");
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_MODEL, "plan-minimax", "the box did move");
    assert.equal(stub.secretsOf(box).SAND_OPENAI_COMPATIBLE_MODEL_LABEL, undefined, "GLM-5.3 must not outlive the model it named");

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

// ---- the ceiling door (AGENTS-CAP-2) -----------------------------------------------------------
//
// The one route on this relay that both reads and writes, so it is the one where the deliberate
// order of the door could most easily be lost: 404 with no control plane, the METHOD refusal before
// the credential, then a constant-time compare. Its docker half is measured on a real box by
// scripts/verify-onboarding.mjs --cap; what is worth holding here is the door.

test("the ceiling door keeps its order: no control plane, then the method, then the credential", async () => {
  const solo = await startRelay({}, { prefix: "relay-ceiling-solo-" });
  try {
    // A console with no control plane serves neither read nor write. 404 rather than 401 is the
    // truthful shape: this route does not exist here.
    for (const method of ["GET", "POST"]) {
      const res = await fetch(`${solo.base}/admin/tenants/demo/ceiling`, {
        method, headers: { authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(res.status, 404, `${method} should not exist without a control plane`);
    }
  } finally { solo.stop(); }

  const { relay } = await startMigrationConsole();
  try {
    const url = "/admin/tenants/demo/ceiling";
    // GET and POST are both this route's, and no third method is. The refusal comes before the
    // credential so a wrong method charges nobody and learns nothing about whether the door exists.
    const wrongMethod = await fetch(`${relay.base}${url}`, { method: "DELETE" });
    assert.equal(wrongMethod.status, 405, "a method that is not this route's");
    assert.equal((await fetch(`${relay.base}${url}`)).status, 401, "a read with no credential");
    assert.equal((await post(relay, url, {})).status, 401, "a write with no credential");
    assert.equal((await post(relay, url, {}, { headers: { authorization: `Bearer ${RELAY_TOKEN}x` } })).status, 401,
      "a credential that is nearly right");
    // A console session is not a credential for this door. It is not even a console route.
    const signedIn = await fetch(`${relay.base}/login`, form({ password: RELAY_PASSWORD }));
    const cookie = /(?:^|,\s*)(gb_session=[^;]+)/.exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? "";
    assert.equal((await post(relay, url, {}, { headers: { cookie } })).status, 401, "a console cookie");
    // A workspace this console does not serve is a plain sentence, not a stack trace.
    assert.equal((await asAdmin(relay, "/admin/tenants/nobody/ceiling", {})).status, 404);
  } finally { relay.stop(); }
});

test("a ceiling outside the range never reaches a box, because the host would fail open on it", async () => {
  const { relay } = await startMigrationConsole();
  try {
    // The host takes a settings value only when it is a string inside its own range, and anything
    // else drops that workspace to the product default with nothing on any screen saying why. So
    // the number is checked before a file is touched, on this side as well as at the control plane:
    // whichever of the two is called directly is the one that has to refuse.
    for (const bad of [0, -1, 1001, 2.5, "forty", null]) {
      const res = await asAdmin(relay, "/admin/tenants/demo/ceiling", { maxAgents: bad });
      assert.equal(res.status, 400, `a ceiling of ${JSON.stringify(bad)} was accepted`);
      const body = await res.json();
      assert.match(String(body.error), /whole number from 1 to 1000/);
    }
  } finally { relay.stop(); }
});

test("a ceiling write merges the settings file and writes the number as a STRING", async () => {
  const { relay, stub, box } = await startMigrationConsole();
  try {
    // What a live box holds today. MEASURED READ-ONLY ON THE R750 2026-09-09: all three boxes carry
    // SAND_MAX_AGENTS as a string beside other switches in this same file, and writeBoxFile
    // truncates, so a write of one key alone would take SAND_TOOL_TRACE and SAND_SELF_TALK_CAP with
    // it. That is what this case exists to catch.
    const settings = stub.fileOf(box, "sand-host-settings.json");
    writeFileSync(settings, JSON.stringify({ SAND_TOOL_TRACE: "1", SAND_SELF_TALK_CAP: "3", SAND_MAX_AGENTS: "100" }));

    const res = await asAdmin(relay, "/admin/tenants/demo/ceiling", { maxAgents: 40 });
    assert.equal(res.status, 200, await res.text());

    const after = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(after.SAND_MAX_AGENTS, "40");
    // A NUMBER IS SILENTLY IGNORED by the host's settings reader, which takes a value only when
    // typeof value === "string". A ceiling written as 40 would leave that workspace on the default
    // with nothing anywhere saying why.
    assert.equal(typeof after.SAND_MAX_AGENTS, "string");
    assert.equal(after.SAND_TOOL_TRACE, "1", "the write truncated a neighbour's switch");
    assert.equal(after.SAND_SELF_TALK_CAP, "3", "the write truncated a neighbour's switch");
    assert.equal(statSync(settings).mode & 0o777, 0o600, "and the file a box reads is 0600");
  } finally { relay.stop(); }
});

test("a box whose host cannot be asked answers read false with a reason, never a number", async () => {
  const { relay, stub, box } = await startMigrationConsole();
  try {
    // There is no gateway behind this box in a test process, so getAgentCapacity cannot be asked.
    // "We could not look" and "this workspace holds forty" send an operator to different places,
    // and reporting the first as the second is how a panel comes to show a ceiling over a box
    // nobody checked.
    writeFileSync(stub.fileOf(box, "sand-host-settings.json"), JSON.stringify({ SAND_MAX_AGENTS: "100" }));
    const body = await (await fetch(`${relay.base}/admin/tenants/demo/ceiling`, {
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    })).json();
    assert.equal(body.read, false);
    assert.equal(body.maxAgents, null, "a number was reported for a box that was never asked");
    assert.ok(String(body.why).length > 0, "and with no reason on it");
    assert.equal(body.pinned, false, "an empty container environment is not a pin");
  } finally { relay.stop(); }
});

test("a box with no settings file at all gets a flat one, not a nested one", async () => {
  const { relay, stub, box } = await startMigrationConsole();
  try {
    // grok-bot-local-vm holds no SAND_MAX_AGENTS at all, which is exactly the box this wave measures
    // the default on, so the missing-file path is the one that matters most. It wrote a NESTED
    // document until this case existed, because the shape was decided by an identity test on two
    // objects that were both empty and both new.
    const settings = stub.fileOf(box, "sand-host-settings.json");
    assert.throws(() => readFileSync(settings, "utf8"), "the fixture already has a settings file");

    const res = await asAdmin(relay, "/admin/tenants/demo/ceiling", { maxAgents: 40 });
    assert.equal(res.status, 200, await res.text());

    const after = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(after.SAND_MAX_AGENTS, "40");
    assert.equal(after.settings, undefined, "a box with no file was given a nested document");
  } finally { relay.stop(); }
});

test("a box whose settings are nested keeps them nested", async () => {
  const { relay, stub, box } = await startMigrationConsole();
  try {
    // The other shape the host reads. Rewriting a nested file as a flat one would drop every other
    // switch in it, which is the same truncation the merge exists to avoid.
    const settings = stub.fileOf(box, "sand-host-settings.json");
    writeFileSync(settings, JSON.stringify({ version: 2, settings: { SAND_TOOL_TRACE: "1" } }));

    assert.equal((await asAdmin(relay, "/admin/tenants/demo/ceiling", { maxAgents: 40 })).status, 200);

    const after = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(after.settings.SAND_MAX_AGENTS, "40");
    assert.equal(after.settings.SAND_TOOL_TRACE, "1");
    assert.equal(after.version, 2, "the document around the settings was dropped");
    assert.equal(after.SAND_MAX_AGENTS, undefined, "the value was also written flat, where the host would not look for it");
  } finally { relay.stop(); }
});

// SIGNIN-1. The user agent, all the way from the request to the control plane's read.
//
// This is the half that was already built, and the case exists to hold it rather than to add to it.
// ui/server.mjs fills the field from the request on every attempt, ui/login-ledger.mjs clips it to
// 120 characters and forces it to a string, and this route projects nothing: it hands back whole
// rows. So a gate that names itself at the door (scripts/gate-agent.mjs) is legible on the other
// side without one line of relay code changing, and the case below is what says so out loud.
//
// What the panel then DOES with the string is deliberately narrower than the string, because a user
// agent is written by whoever is knocking. docs/ADMIN.md, "Telling a gate from an attacker", is the
// rule; nothing in this file is a claim that the prefix proves anything.
test("the ledger route hands back the user agent it was sent, gate or browser or neither", async () => {
  const relay = await startRelay(withControlPlane, { prefix: "relay-admin-agent-" });
  try {
    const knock = (userAgent) => fetch(`${relay.base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        ...(userAgent === undefined ? {} : { "user-agent": userAgent }),
      },
      body: new URLSearchParams({ password: `${TRIED}-agent` }).toString(),
    });

    // Five callers at one door, and the last two are the point of the case.
    //
    // Measured on this Mac while writing it: node's own `fetch` sends `user-agent: node` when
    // nobody sets one, and node's raw `http.request` sends NO user agent header at all. That is
    // where both shapes in the live ledger come from -- "node" from every gate leg written with
    // fetch, empty from verify-deploy's raw https origin-bypass leg -- and it is why the panel's
    // rule can never be an absence test: a blank agent is also what every row from the control
    // plane's own door carries (cp/store.mjs hands the panel a hardcoded empty string), so reading
    // absence as "one of ours" would silence a stranger who simply sent no header.
    await knock("titanbot-gate/verify-deploy");
    await knock("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
    await knock(undefined);
    await knockWithNoAgentHeader(relay.base, `${TRIED}-agent`);
    await knock(`titanbot-gate/${"y".repeat(400)}`);

    const body = await waitForRows(
      () => fetch(`${relay.base}/admin/login-attempts`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } }),
      (rows) => rows.filter((row) => row.outcome === "refused" && row.door === "instance").length >= 5,
    );
    const refused = body.rows.filter((row) => row.outcome === "refused" && row.door === "instance");
    const agents = refused.map((row) => row.userAgent);

    assert.equal(agents.includes("titanbot-gate/verify-deploy"), true,
      `the gate's own name reaches the reader unchanged: ${JSON.stringify(agents)}`);
    assert.equal(agents.some((agent) => agent.startsWith("Mozilla/5.0 ")), true,
      `and so does a browser's: ${JSON.stringify(agents)}`);
    assert.equal(agents.includes("node"), true,
      `an unnamed fetch arrives as the word node, which is what every gate leg wrote before this wave: ${JSON.stringify(agents)}`);
    assert.equal(agents.includes(""), true,
      `and a caller that sent no header at all is an empty string, not a missing key: ${JSON.stringify(agents)}`);
    for (const row of refused) {
      assert.equal(typeof row.userAgent, "string", `${JSON.stringify(row)} carries no agent field at all`);
      assert.equal(row.userAgent.length <= 120, true, `${row.userAgent.length} characters got past the clip`);
    }
    assert.equal(agents.some((agent) => agent.length === 120 && agent.startsWith("titanbot-gate/yyy")), true,
      `an oversize agent is clipped and kept rather than dropped: ${JSON.stringify(agents.map((a) => a.length))}`);
  } finally { relay.stop(); }
});
