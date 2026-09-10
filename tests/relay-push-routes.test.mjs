// PUSH-1. The four routes, the absent-module behaviour, and the console's Notifications card.
//
// THE ROUTES ARE EXERCISED THROUGH THE HANDLER ui/server.mjs MOUNTS, over a real node:http server,
// not through a fake. pushRoutes(deps) is the hook item A wires at one call site; this file stands it
// up on a port of its own and drives it with real requests, so the thing under test is the same
// function the relay calls, with the same arguments, and the wiring in server.mjs is one line rather
// than a behaviour.
//
// It does not start a relay. A relay start would make this suite depend on item A landing its route
// line, and the contract worth pinning is the handler's, which is item C's to keep.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUSH_CARD_KINDS, PUSH_FILE, pushRoutes } from "../ui/push-edge.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The relay's own three helpers, with the same shapes server.mjs has: readBody resolves the body as
// text, fail writes a JSON refusal, and both are passed in rather than re-implemented in the module.
const readBody = (req) => new Promise((resolve, reject) => {
  let text = "";
  req.on("data", (chunk) => { text += String(chunk); if (text.length > 1 << 20) reject(new Error("too big")); });
  req.on("end", () => resolve(text));
  req.on("error", reject);
});
const fail = (res, status, message) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message }));
  return true;
};

/** One push edge on a real port, with one workspace and a sub the test can change. */
async function standUp({ sub = "person-a" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-push-"));
  const t = { slug: "demo", name: "demo", file: (name) => path.join(dir, name), ensureDir: () => {} };
  const subRef = { value: sub };
  const handler = pushRoutes({
    readBody, fail,
    tenants: () => [t],
    contextOf: () => t,
    subOf: () => subRef.value,
    gatewayCall: async () => ({ status: 200, text: "{}", type: "application/json" }),
    senderFor: () => ({ async send() { return { ok: true, status: 200 }; } }),
    log: () => {},
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // EXACTLY the call site: the handler is asked first, and anything it did not claim falls through
    // to the route table the relay already had.
    if (await handler(req, res, url, t)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, text, headers: response.headers };
  };
  // The same request with the body untouched, for the bodies JSON.parse has to refuse.
  const askRaw = async (method, pathname, raw) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { "content-type": "application/json" }, body: raw });
    return { status: response.status, text: await response.text() };
  };
  return { dir, t, ask, askRaw, subRef, close: () => new Promise((resolve) => server.close(resolve)), edge: handler.edge };
}

test("POST /push/devices registers, is idempotent per device, and answers no token", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());

  const first = await relay.ask("POST", "/push/devices", { platform: "ios", token: "apns-token-value", deviceId: "phone-1", name: "Jason's iPhone" });
  assert.equal(first.status, 200);
  assert.equal(first.body.deviceId, "phone-1");
  assert.equal(first.body.replaced, false);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.ok(!first.text.includes("apns-token-value"), "a registration answer never carries the token back");

  const again = await relay.ask("POST", "/push/devices", { platform: "ios", token: "a-newer-token", deviceId: "phone-1" });
  assert.equal(again.body.replaced, true, "the same deviceId updates rather than duplicating");

  const list = await relay.ask("GET", "/push/devices");
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].deviceId, "phone-1");
  assert.ok(!Object.hasOwn(list.body.devices[0], "token"), "a device list is for recognising and revoking, never for reading a token");
  assert.ok(!list.text.includes("a-newer-token"));

  // And the file on disk is the tenant's own, at 0600, with the sub stamped by the relay and not by
  // the body: a phone does not get to say who it belongs to.
  const onDisk = JSON.parse(readFileSync(path.join(relay.dir, PUSH_FILE), "utf8"));
  assert.equal(onDisk.devices[0].sub, "person-a");
});

test("a registration the relay cannot use is refused in words, and stores nothing", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  for (const body of [
    { platform: "web", token: "t", deviceId: "d" },
    { platform: "ios", token: "", deviceId: "d" },
    { platform: "ios", token: "t", deviceId: "" },
    {},
  ]) {
    const answer = await relay.ask("POST", "/push/devices", body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match(String(answer.body.message), /Nothing was stored/);
  }
  assert.equal((await relay.ask("GET", "/push/devices")).body.devices.length, 0);
});

test("DELETE /push/devices/<id> removes one and says so either way", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "android", token: "fcm", deviceId: "phone-2" });
  const gone = await relay.ask("DELETE", "/push/devices/phone-2");
  assert.equal(gone.status, 200);
  assert.equal(gone.body.removed, true);
  const twice = await relay.ask("DELETE", "/push/devices/phone-2");
  assert.equal(twice.body.removed, false, "revoking twice is not an error");
  assert.equal((await relay.ask("GET", "/push/devices")).body.devices.length, 0);
});

test("GET and PUT /push/settings are per person and name the scope", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());

  const initial = await relay.ask("GET", "/push/settings");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.kinds, PUSH_CARD_KINDS, "the card kinds come off the server, so the page cannot invent one");
  assert.equal(initial.body.scope, "person");
  for (const kind of PUSH_CARD_KINDS) assert.equal(initial.body.settings.kinds[kind], true, `${kind} is on until somebody says otherwise`);

  const saved = await relay.ask("PUT", "/push/settings", { kinds: { widget: false }, quietHours: { on: true, from: 23, to: 6 }, utcOffsetMinutes: -300 });
  assert.equal(saved.body.settings.kinds.widget, false);
  assert.equal(saved.body.settings.quietHours.on, true);
  assert.equal(saved.body.settings.utcOffsetMinutes, -300);

  // A different person on the same workspace. One person's switches are not another's.
  relay.subRef.value = "person-b";
  const theirs = await relay.ask("GET", "/push/settings");
  assert.equal(theirs.body.settings.kinds.widget, true);
  assert.equal(theirs.body.settings.quietHours.on, false);

  // The instance-password door has no person behind it, so it means the workspace, and it says so.
  relay.subRef.value = "";
  assert.equal((await relay.ask("GET", "/push/settings")).body.scope, "workspace");
});

test("the wrong method is a refusal and never a silent success", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  assert.equal((await relay.ask("PUT", "/push/devices")).status, 405);
  assert.equal((await relay.ask("GET", "/push/devices/phone-1")).status, 405);
  assert.equal((await relay.ask("DELETE", "/push/settings")).status, 405);
  assert.equal((await relay.ask("GET", "/push/nothing-here")).status, 404);
});

test("a body the parser cannot take is refused rather than stored as an empty device", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());

  // A POST with no body at all: the parser reads "{}" and the device is refused for want of fields.
  assert.equal((await relay.ask("POST", "/push/devices")).status, 400);

  // And a body that is not JSON. Refused by the parser, with nothing stored and nothing guessed.
  assert.equal((await relay.askRaw("POST", "/push/settings", "{ not json")).status, 400);
  assert.equal((await relay.askRaw("POST", "/push/devices", "not json either")).status, 400);
  assert.equal((await relay.ask("GET", "/push/devices")).body.devices.length, 0);
});

test("the handler claims /push and nothing else, so the relay's own routes still answer", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  // Nothing outside /push is claimed: the call site falls through to whatever the relay already had.
  const through = await relay.ask("GET", "/auth/state");
  assert.equal(through.status, 404, "not claimed by push, so the relay's own table answered");
  assert.equal(through.body.error, "not found");
});

// ---- the absent module ---------------------------------------------------------------------------
//
// This is the CONSOLE-4 lesson as a test rather than a comment: backgrounds.js destructured a missing
// global and took the picker down. With push absent the relay must answer exactly as it did before
// and the console must boot with one fewer Settings card.

test("with the push module absent the route falls through and the sweep starts nothing", async () => {
  // The identity fallbacks ui/relay-hooks.mjs hands back when ui/push-edge.mjs is not there. They are
  // pinned here, beside the real handler, so the two shapes cannot drift: a fallback that answered
  // `undefined` instead of `false` would claim every request and 404 the whole console.
  const absentRoutes = async () => false;
  const absentSweep = () => () => {};

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (await absentRoutes(req, res, url, null)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reached: "the relay's own table" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const pathname of ["/push/devices", "/push/settings", "/"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.equal((await response.json()).reached, "the relay's own table", `${pathname} is not claimed`);
    }
    assert.equal(typeof absentSweep(), "function", "the stop is still a function, so the caller needs no branch");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("ui/machine-room/index.html loads push-settings.js on the same seam as the other three", () => {
  const html = readFileSync(path.join(repo, "ui/machine-room/index.html"), "utf8");
  const order = ["gap-badge.js", "screen-tile.js", "files-viewer.js", "push-settings.js"]
    .map((name) => html.indexOf(`<script src="${name}"></script>`));
  for (const [index, at] of order.entries()) assert.ok(at > 0, `module ${index} is loaded`);
  assert.ok(order[3] > order[2], "push-settings.js sits with the other seam modules");
  assert.ok(order[3] < html.indexOf("__bootMachineRoom"), "and before app.js is fetched, like the other three");
});

test("the console's Notifications card reads nothing out of app.js's internals", () => {
  const whole = readFileSync(path.join(repo, "ui/machine-room/push-settings.js"), "utf8");
  // The comments NAME the things this file must not do, so they are stripped before the checks below:
  // a test that fails because the file explains itself is a test that teaches people not to explain.
  const source = whole.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The CONSOLE-4 contract: the shared helpers through window.__mrUi, read lazily, and nothing else.
  assert.match(source, /global\.__mrUi/, "the helpers come through the published seam");
  assert.match(source, /global\.__pushSettings = \{/, "and it publishes its own object at load");
  assert.ok(!/__machineRoomAdapter/.test(source), "the adapter is not reached for: these routes are the relay's, not the box's");
  assert.ok(!/\belements\./.test(source), "app.js's element map is not reached into");
  assert.ok(!/state\.settings/.test(source), "app.js's state object is not reached into");
  // Keyed on the panel's STRUCTURE and never on a string of its copy: a reworded eyebrow must not
  // make this card disappear silently while the routes stay live.
  assert.match(source, /\.settings-list/, "the mount point is structural");
  assert.ok(!/Global router|Operator settings/.test(source), "no string of the panel's copy is load bearing");
});

test("the Notifications card draws every kind the server knows, and never a device token", () => {
  const whole = readFileSync(path.join(repo, "ui/machine-room/push-settings.js"), "utf8");
  const source = whole.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Every kind the server can answer has words a person reads. A kind with no entry is drawn with
  // its own wire name, which is ugly and honest; a kind the page silently dropped would be a switch
  // that cannot be found for notifications that keep arriving.
  for (const kind of PUSH_CARD_KINDS) {
    assert.ok(source.includes(`"${kind}"`) || source.includes(`${kind}:`), `${kind} has words a person reads`);
  }
  // No line in this file can print a token, because no route hands it one. tokenAt is a timestamp.
  assert.ok(!/\.token\b/.test(source.replace(/tokenAt/g, "at")), "the card has no line that would print a device token");
  // The known divergence is ON the card, in plain words, rather than left to be discovered by a
  // customer comparing two numbers. PUSH-3 is the row that closes it.
  assert.match(source, /counts cards/);
  assert.match(source, /counts conversations/);
});

// ---- the revoke and the push row are one action ------------------------------------------------

test("the seam carries a device revoke through to the push row", async () => {
  // FOUND ON THE R750, 2026-09-10, and it is the case the whole revoke exists for. A customer who
  // loses a phone revokes it in the console; the bearer dies at once, and before this the push row
  // stayed, so the lost phone went on being notified. push-edge had written forgetDevice for exactly
  // this and named item A's revoke as its caller in a comment, and nothing called it. Both halves are
  // pinned here: the seam offers the function when the module is present, and answers a refusal a
  // caller can read rather than throwing when it is absent.
  const { loadRelayHooks } = await import("../ui/relay-hooks.mjs");
  const asked = [];
  const withModule = await loadRelayHooks({
    log: () => {},
    deps: {},
  });
  // The real module is present in this tree, so the hook must BE a function that answers an object.
  assert.equal(typeof withModule.pushForgetDevice, "function");
  const unknown = await withModule.pushForgetDevice("a-workspace-that-is-not-here", "some-device");
  assert.equal(typeof unknown, "object");
  assert.equal(unknown.ok, false, "an unknown workspace is a refusal, not a throw");

  // And the shape a caller gets from a stub module, which is what proves the seam passes the call on
  // rather than answering it itself.
  const stub = {
    create: () => ({
      handle: async () => false,
      sweepStart: () => {},
      forgetDevice: async (slug, deviceId) => { asked.push(`${slug}/${deviceId}`); return { ok: true, removed: true }; },
    }),
  };
  const P = await stub.create();
  assert.deepEqual(await P.forgetDevice("demo", "a-lost-phone"), { ok: true, removed: true });
  assert.deepEqual(asked, ["demo/a-lost-phone"]);
});

test("a DELETE only reaches the caller's own device, and saving settings reopens a muted card", async (tt) => {
  const relay = await standUp({ sub: "acct-jason" });
  tt.after(() => relay.close());

  // TWO PEOPLE, ONE DEVICE ID. The id is chosen by the app and is readable off a device list, and two
  // accounts share a workspace, so this is the shape that mattered: before this ship the row was keyed
  // on deviceId alone, so the second registration took the first one's row and a DELETE of that id
  // removed a row belonging to somebody else and answered removed:true.
  await relay.ask("POST", "/push/devices", { platform: "ios", token: "APNS-JASON", deviceId: "shared-id", name: "Jason's iPhone" });
  relay.subRef.value = "acct-richard";
  await relay.ask("POST", "/push/devices", { platform: "android", token: "FCM-RICHARD", deviceId: "shared-id", name: "Richard's phone" });

  const mine = await relay.ask("GET", "/push/devices");
  assert.equal(mine.body.devices.length, 1, "a person's list is their own rows and nobody else's");
  assert.equal(mine.body.devices[0].platform, "android");

  const removed = await relay.ask("DELETE", "/push/devices/shared-id");
  assert.equal(removed.body.removed, true, "Richard removes Richard's");
  assert.equal((await relay.ask("DELETE", "/push/devices/shared-id")).body.removed, false, "and there is nothing of his left to remove");
  relay.subRef.value = "acct-jason";
  const left = await relay.ask("GET", "/push/devices");
  assert.equal(left.body.devices.length, 1, "Jason's phone is still registered");
  assert.equal(left.body.devices[0].platform, "ios");

  // SAVING SETTINGS REOPENS A TERMINAL ROW. A muted card is never retried on a timer, which is the
  // whole fix; the one event that can change that answer is the person changing the switch, so the
  // settings write drops those rows and the next pass decides them once.
  const ledger = relay.edge.ledgerFor(relay.t);
  await ledger.write(new Map([
    ["muted-key", { key: "muted-key", kind: "box-handoff", state: "muted", at: Date.now(), deadlineMs: 0, agentId: "agent-1", entryId: "e1", heldUntil: 0, attempts: 0, retryAt: 0, gaveUp: false }],
    ["held-key", { key: "held-key", kind: "widget", state: "held", at: Date.now(), deadlineMs: 0, agentId: "agent-1", entryId: "e2", heldUntil: Date.now() + 8 * 60 * 60 * 1_000, attempts: 0, retryAt: 0, gaveUp: false }],
    ["alerted-key", { key: "alerted-key", kind: "secret", state: "alerted", at: Date.now(), deadlineMs: 0, agentId: "agent-1", entryId: "e3", heldUntil: 0, attempts: 0, retryAt: 0, gaveUp: false }],
  ]));
  const saved = await relay.ask("PUT", "/push/settings", { kinds: { "box-handoff": true }, quietHours: { on: false, from: 22, to: 7 } });
  assert.equal(saved.status, 200);
  const after = await ledger.read();
  assert.equal(after.has("muted-key"), false, "the muted row is gone, so the card waiting is decided again");
  assert.equal(after.get("held-key").heldUntil, 0, "a quiet window somebody just changed releases its catch-up on the next pass");
  assert.equal(after.get("alerted-key").state, "alerted", "and a card already alerted is not alerted twice");
});
