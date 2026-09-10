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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
async function standUp({ sub = "person-a", roster = null, tail = null, reports = null, boxAnswers = true, streamMaxMs } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-push-"));
  const t = { slug: "demo", name: "demo", file: (name) => path.join(dir, name), ensureDir: () => {} };
  const subRef = { value: sub };
  // What ui/server.mjs wires to a fresh device-session read. A test flips it to revoke the bearer a
  // stream is already holding, which is the only way to reach the case the R750 measured.
  const liveRef = { value: true };
  const sent = [];
  const handler = pushRoutes({
    readBody, fail,
    tenants: () => [t],
    contextOf: () => t,
    subOf: () => subRef.value,
    stillLive: () => liveRef.value,
    // A box stands in, because the two routes a shell reads are the ones that project a real
    // transcript. `{}` for everything is the default, which is what an older host answers.
    gatewayCall: async (_t, command) => {
      if (!boxAnswers) return { status: 0, text: "", type: "" };
      const body = command === "listAgents" ? (roster ?? {})
        : command === "listProblemReports" ? { reports: reports?.() ?? [] }
          : command === "getAgentTranscriptTail" ? { entries: tail?.() ?? [] }
            : {};
      return { status: 200, text: JSON.stringify(body), type: "application/json" };
    },
    // The stream's own clocks, turned down so a test is seconds rather than a minute. Production
    // numbers are the defaults in ui/push-edge.mjs and are printed in docs/APPS.md.
    streamDebounceMs: 25,
    streamMinAgeMs: 50,
    streamRefreshMs: 150,
    streamHeartbeatMs: 60_000,
    ...(streamMaxMs === undefined ? {} : { streamMaxMs }),
    senderFor: () => ({ async send(row) { sent.push(row); return { ok: true, status: 200 }; } }),
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
  const listening = new Set();
  /** One SSE connection, read as whole frames, with the reader closed by the caller. */
  const listen = async (pathname = "/push/events") => {
    const controller = new AbortController();
    listening.add(controller);
    const response = await fetch(`${base}${pathname}`, { headers: { accept: "text/event-stream" }, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let held = "";
    const frames = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          held += decoder.decode(value, { stream: true });
          for (;;) {
            const cut = held.indexOf("\n\n");
            if (cut < 0) break;
            const block = held.slice(0, cut);
            held = held.slice(cut + 2);
            if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice("data: ".length)));
          }
        }
      } catch { /* the caller hung up */ }
    })();
    let ended = false;
    void pump.then(() => { ended = true; });
    return {
      status: response.status,
      headers: response.headers,
      frames,
      /** Whether the SERVER ended this stream, as opposed to the caller hanging up. */
      get ended() { return ended; },
      async waitForEnd(ms = 3000) {
        const stop = Date.now() + ms;
        while (!ended && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 25));
        return ended;
      },
      /** Waits for at least `want` frames, or gives up, so a test never hangs on one that never comes. */
      async settle(want, ms = 3000) {
        const stop = Date.now() + ms;
        while (frames.length < want && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 25));
        return frames;
      },
      close() { listening.delete(controller); controller.abort(); return pump; },
    };
  };
  // Every open stream first, then the edge, then the port: server.close() waits for its connections,
  // and an SSE connection is a connection that never ends on its own.
  const close = async () => {
    for (const controller of [...listening]) { listening.delete(controller); controller.abort(); }
    handler.edge.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { dir, t, ask, askRaw, listen, sent, subRef, liveRef, close, edge: handler.edge };
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

// ---- APPS-DOC-1: the wire shape, refused by name rather than answered 200 and ignored -----------
//
// THE DEFECT, measured on grok-bot-local-vm 2026-09-10 against the real handler over a temp state
// directory. The prose in docs/APPS.md named these fields without spelling them, the phone app sent
// the prose's reading, and the route answered 200 {"message":"Saved."} -- and did not merely ignore
// the body, it OVERWROTE with the defaults. A phone "saving quiet hours" switched the customer's
// quiet hours OFF and turned two kinds they had muted back ON.

test("the shape the document's prose implied is refused by name, and changes nothing", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());

  // What the customer holds before the bad save.
  await relay.ask("PUT", "/push/settings", { kinds: { widget: false, secret: false }, quietHours: { on: true, from: 23, to: 6 }, utcOffsetMinutes: -300 });

  // The prose's reading, which used to answer 200 and write the defaults over all of that.
  const refused = await relay.ask("PUT", "/push/settings", { enabled: true, kinds: ["widget"], quietHours: { enabled: true, fromHour: 1, toHour: 9 } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "bad_request");
  assert.equal(refused.body.field, "enabled", "the 400 names the first field that stopped it");
  assert.match(refused.body.message, /no setting called "enabled"/);
  assert.match(refused.body.message, /Nothing was stored/);

  // AND THE POINT OF THE WHOLE ROW: the customer's switches are exactly as they were.
  const after = await relay.ask("GET", "/push/settings");
  assert.equal(after.body.settings.kinds.widget, false);
  assert.equal(after.body.settings.kinds.secret, false);
  assert.equal(after.body.settings.quietHours.on, true);
  assert.equal(after.body.settings.quietHours.from, 23);
  assert.equal(after.body.settings.utcOffsetMinutes, -300);

  // A list where a map belongs, once the unknown top-level field is gone, is named too.
  const list = await relay.ask("PUT", "/push/settings", { kinds: ["widget"] });
  assert.equal(list.status, 400);
  assert.equal(list.body.field, "kinds");
  assert.match(list.body.message, /map of card kind/);
});

test("a type is strict, because loose coercion gave one body three different answers", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  // MEASURED, all three in one run against the old route: kinds:{widget:"false"} stayed ON (only a
  // strict false muted), quietHours.on:"true" read OFF (only a strict true armed), and
  // utcOffsetMinutes:"-300" was honoured. Three outcomes, no complaint about any of them.
  for (const [body, field] of [
    [{ kinds: { widget: "false" } }, "kinds.widget"],
    [{ quietHours: { on: "true" } }, "quietHours.on"],
    [{ utcOffsetMinutes: "-300" }, "utcOffsetMinutes"],
    [{ kinds: { mentions: false } }, "kinds.mentions"],
    [{ quietHours: { fromHour: 1 } }, "quietHours.fromHour"],
  ]) {
    const answer = await relay.ask("PUT", "/push/settings", body);
    assert.equal(answer.status, 400, `${JSON.stringify(body)} is refused`);
    assert.equal(answer.body.field, field);
  }
  // An hour out of range is REFUSED rather than wrapped. clampHour is a modulo, so 99 used to store as
  // 3 and -4 as 20: a typo silently became a different, perfectly valid quiet window.
  for (const hours of [{ from: 99 }, { to: -4 }, { from: 1.5 }]) {
    const answer = await relay.ask("PUT", "/push/settings", { quietHours: hours });
    assert.equal(answer.status, 400, `${JSON.stringify(hours)} is refused`);
    assert.match(answer.body.message, /whole hour from 0 to 23/);
  }
  // And a body that is not an object at all. Both of these answered 200 "Saved." and wrote defaults.
  for (const raw of ["[1,2]", '"hello"', "null"]) {
    const answer = await relay.askRaw("PUT", "/push/settings", raw);
    assert.equal(answer.status, 400, `${raw} is refused`);
    assert.match(answer.text, /has to be a JSON object/);
  }
});

test("a field left out means unchanged, so a panel may send only what the person touched", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  // THE DEFECT: the route was a full REPLACE. With two kinds off and quiet hours on, a later
  // PUT {kinds:{report:false}} answered 200 and left every other switch back at the default.
  await relay.ask("PUT", "/push/settings", { kinds: { widget: false, secret: false }, quietHours: { on: true, from: 23, to: 6 }, utcOffsetMinutes: -300 });
  const partial = await relay.ask("PUT", "/push/settings", { kinds: { report: false } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.settings.kinds.report, false, "what was sent landed");
  assert.equal(partial.body.settings.kinds.widget, false, "and what was not sent is untouched");
  assert.equal(partial.body.settings.kinds.secret, false);
  assert.equal(partial.body.settings.quietHours.on, true);
  assert.equal(partial.body.settings.quietHours.from, 23);
  assert.equal(partial.body.settings.utcOffsetMinutes, -300);

  // An empty object is a valid no-op: every field absent, so every field unchanged.
  const nothing = await relay.ask("PUT", "/push/settings", {});
  assert.equal(nothing.status, 200);
  assert.equal(nothing.body.settings.kinds.widget, false);
  assert.equal(nothing.body.settings.quietHours.on, true);
});

test("a POST to /push/settings is a 405, which is what the route's own sentence always said", async (tt) => {
  const relay = await standUp();
  tt.after(() => relay.close());
  // The route accepted POST while its own refusal sentence said "GET or PUT", docs/APPS.md said PUT,
  // and both shells wrote "a POST is not a route" in their contract notes. Three statements of a rule
  // the code did not keep.
  const posted = await relay.ask("POST", "/push/settings", { kinds: { widget: false } });
  assert.equal(posted.status, 405);
  assert.equal(posted.body.error, "GET or PUT");
  assert.equal((await relay.ask("GET", "/push/settings")).body.settings.kinds.widget, true, "and nothing was stored by it");
});

// ---- PUSH-5: GET /push/pending -------------------------------------------------------------------

const HANDOFF = {
  kind: "send-message", id: "t14s0", timestampMs: Date.UTC(2026, 8, 10, 10, 0, 0),
  boxRequestId: "box-1", boxInstruction: "Sign in to the bank so I can download the statement",
  message: { type: "text", content: "I need you at the keyboard." },
};
const WIDGET = {
  kind: "send-message", id: "t12s0", timestampMs: Date.UTC(2026, 8, 10, 10, 0, 0),
  message: { type: "widget", widget: { prompt: "Which invoice should I chase first?" } },
};
const ROSTER = [{ id: "agent-1", name: "Books", newestEntryId: "t14s0", unreadCount: 1, updatedAt: 1 }];

test("GET /push/pending answers the decided list off the relay's own decider", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF, WIDGET] });
  tt.after(() => relay.close());

  const answer = await relay.ask("GET", "/push/pending");
  assert.equal(answer.status, 200);
  assert.equal(answer.body.badge, 2, "the workspace's unfiltered pending count, the same number a push carries");
  assert.equal(answer.body.agents, 1);
  assert.equal(answer.body.cards.length, 2);
  assert.equal(answer.headers.get("cache-control"), "no-store");

  const handoff = answer.body.cards.find((card) => card.kind === "box-handoff");
  assert.equal(handoff.agent.id, "agent-1");
  assert.equal(handoff.agent.name, "Books");
  assert.equal(handoff.entry, "t14s0");
  assert.equal(handoff.requestId, "box-1");
  assert.equal(handoff.pending, true);
  assert.equal(handoff.muted, false);
  assert.equal(handoff.title, "Take the keyboard for Books", "the title a push carries, not the agent's own instruction");
  assert.equal(handoff.body, "Open it to read what it needs done.", "one of the six fixed sentences");
  assert.equal(handoff.link.app, "titaniumbot://card?tenant=demo&agent=agent-1&entry=t14s0&kind=box-handoff");
  assert.ok(handoff.link.web.endsWith("/?agent=agent-1&entry=t14s0"));
  assert.match(handoff.key, /^[0-9a-f]{32}$/, "the same collapse key a push uses");
  // RULE 5. The instruction the agent wrote is the field a notification body never carries, and this
  // route is a notification body with a different shape.
  assert.ok(!answer.text.includes("Sign in to the bank"));
});

test("the caller's own switches decorate a row and never change the badge", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF, WIDGET] });
  tt.after(() => relay.close());
  await relay.ask("PUT", "/push/settings", { kinds: { widget: false } });

  const answer = await relay.ask("GET", "/push/pending");
  assert.equal(answer.body.badge, 2, "the card is still waiting whether or not anybody was told about it");
  assert.equal(answer.body.cards.find((card) => card.kind === "widget").muted, true);
  assert.equal(answer.body.cards.find((card) => card.kind === "box-handoff").muted, false);

  // Another person on the same workspace has their own switches and the same badge.
  relay.subRef.value = "person-b";
  const theirs = await relay.ask("GET", "/push/pending");
  assert.equal(theirs.body.badge, 2);
  assert.equal(theirs.body.cards.find((card) => card.kind === "widget").muted, false);
});

test("a second read inside the memo window is the same picture with its age on it", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF] });
  tt.after(() => relay.close());
  const before = relay.edge.stats().gatewayCalls;
  const first = await relay.ask("GET", "/push/pending");
  const cost = relay.edge.stats().gatewayCalls - before;
  assert.equal(cost, 3, "one listAgents, one listProblemReports and one tail read on a one-agent box");
  assert.equal(first.body.ageMs, 0);

  const second = await relay.ask("GET", "/push/pending");
  assert.equal(relay.edge.stats().gatewayCalls - before, cost, "a poll inside the memo window costs nothing");
  assert.equal(second.body.at, first.body.at, "and is the same picture");
  assert.ok(second.body.ageMs >= 0, "with the age on it, so a caller can see how old what it got is");
  assert.equal(second.body.memoMs, 5000);
});

test("a box that does not answer is a 503 and never an empty list", async (tt) => {
  // An empty list tells a tray everything has been answered, which is a customer's badge dropping to
  // zero because a box was briefly unreachable. That is the same failure shape as the bare-array
  // roster this module's own gate caught: absent, not red.
  const relay = await standUp({ boxAnswers: false });
  tt.after(() => relay.close());
  const answer = await relay.ask("GET", "/push/pending");
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, "no_answer");
  assert.ok(!Object.hasOwn(answer.body, "cards"));
});

test("/push/pending is a GET, and the method is refused in words", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF] });
  tt.after(() => relay.close());
  assert.equal((await relay.ask("POST", "/push/pending", {})).status, 405);
  assert.equal((await relay.ask("POST", "/push/events", {})).status, 405);
});

// ---- PUSH-4: the desktop transport over a real SSE connection ------------------------------------

test("GET /push/events carries the pending cards on connect, with the headers a live edge needs", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF, WIDGET] });
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });

  const stream = await relay.listen();
  tt.after(() => stream.close());
  assert.equal(stream.status, 200);
  // The exact header set relayEvents already proves through Cloudflare in front of the R750. A stream
  // that invents its own passes locally and stalls live.
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("cache-control"), "no-cache");
  assert.equal(stream.headers.get("x-accel-buffering"), "no");

  const frames = await stream.settle(2);
  assert.equal(frames.length, 2);
  assert.ok(frames.every((frame) => frame.channel === "push-card"));
  const handoff = frames.map((frame) => frame.payload).find((card) => card.kind === "box-handoff");
  assert.equal(handoff.state, "pending");
  assert.equal(handoff.badge, 2);
  assert.equal(handoff.title, "Take the keyboard for Books");
  assert.equal(handoff.body, "Open it to read what it needs done.");
  assert.ok(!JSON.stringify(frames).includes("Sign in to the bank"), "no field a model wrote rides a frame");
  assert.ok(!JSON.stringify(frames).includes("a-device-id"), "and no device token either");
});

test("registering a desktop arms nothing, and a connected one is what arms a pass", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF] });
  tt.after(() => relay.close());
  const registered = await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.platform, "desktop");

  const quiet = await relay.edge.sweepOnce("nobody listening");
  assert.equal(quiet.swept[0].skipped, "only a desktop is registered and none is listening");
  assert.equal(quiet.swept[0].calls, 0, "a registered desktop costs its workspace nothing while nobody is connected");
  assert.equal(relay.sent.length, 0, "and no vendor is ever asked about a desktop");

  const stream = await relay.listen();
  tt.after(() => stream.close());
  await stream.settle(1);
  const busy = await relay.edge.sweepOnce("one listening");
  assert.equal(busy.swept[0].skipped, undefined);
  assert.equal(busy.swept[0].listening, 1);
  assert.equal(relay.sent.length, 0, "still nothing to a vendor");
});

test("a card answered while a tray is connected arrives as a closed frame on the same key", async (tt) => {
  let open = true;
  const relay = await standUp({
    roster: ROSTER,
    // The host rewrites the stamp in place, so a hand-off that has been handed back carries a
    // boxResolution on the same entry rather than a new one.
    tail: () => [open ? HANDOFF : { ...HANDOFF, boxResolution: "handed_back" }],
  });
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });

  const stream = await relay.listen();
  tt.after(() => stream.close());
  const first = await stream.settle(1);
  assert.equal(first[0].payload.state, "pending");
  const key = first[0].payload.key;

  open = false;
  // The real trigger is a frame off the box's own /events, debounced. With no box behind this harness
  // the fallback refresh is what fires -- fifteen seconds in production, turned down to 150 ms here.
  const settled = await stream.settle(2, 5_000);
  assert.equal(settled.length, 2);
  assert.equal(settled[1].payload.state, "closed");
  assert.equal(settled[1].payload.key, key, "the same key the pending frame used, so a tray takes that notification down");
});

test("a tray never writes the shared ledger, because `alerted` is terminal for every device", async (tt) => {
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF] });
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });
  const stream = await relay.listen();
  tt.after(() => stream.close());
  await stream.settle(1);
  // If a tray delivery were recorded in push-sent.json the same card would be silenced for a phone
  // that registers afterwards, which is rule 4 turned into a defect.
  assert.equal(existsSync(path.join(relay.dir, "push-sent.json")), false);

  // And the phone that registers afterwards IS alerted about the card that was already waiting.
  await relay.ask("POST", "/push/devices", { platform: "ios", token: "apns-one", deviceId: "phone-1" });
  await relay.edge.sweepOnce("after a phone arrived");
  assert.equal(relay.sent.length, 1);
  assert.equal(relay.sent[0].platform, "ios");
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
  // PUT, because a POST to this route is now a 405 and the method is checked before the body is read.
  assert.equal((await relay.askRaw("PUT", "/push/settings", "{ not json")).status, 400);
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

// ---- what the review pass found: a credential that stops being good, and the two switches ---------

test("revoking the bearer ends a stream that is already open, and no card rides it after", async (tt) => {
  // MEASURED ON THE R750 through console.titanium.bot 2026-09-10 15:36:01Z to 15:36:13Z, a throwaway
  // customer account on demo: a device bearer opened GET /push/events (200), was revoked (DELETE
  // /auth/devices/<id> -> 200, and the same bearer then got 401 on GET /push/pending), and the held
  // stream STILL delivered a widget card five seconds later -- title, agent, entry id and deep link --
  // because openStream authenticated once at connect and the 25 s heartbeat kept the connection alive
  // for ever. Revoke is the lost-laptop control. It reaches this connection now.
  const cards = [HANDOFF];
  const relay = await standUp({ roster: ROSTER, tail: () => cards });
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });

  const stream = await relay.listen();
  tt.after(() => stream.close());
  assert.equal(stream.status, 200);
  await stream.settle(1);
  assert.equal(stream.frames.length, 1, "the card that was waiting when the tray connected");

  // Revoked. The bearer this connection was opened with is gone.
  relay.liveRef.value = false;
  const before = stream.frames.length;
  // A second card is raised, which is exactly what leaked live.
  cards.push(WIDGET);

  assert.equal(await stream.waitForEnd(3000), true, "the server ended the stream rather than holding it");
  assert.equal(stream.frames.length, before, "and nothing arrived on it after the revoke");
  // And the connection stops arming the sweep, because the edge no longer counts it.
  assert.equal(relay.edge.streamsFor(relay.t), 0, "a revoked connection is not a listening desktop");
});

test("a stream ends on its own after its lifetime, whatever else happens", async (tt) => {
  // Belt and braces beside the re-check: a relay whose `stillLive` is the default still bounds how
  // long one credential's reach outlives the credential. 15 minutes in production, turned down here.
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF], streamMaxMs: 250 });
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });
  const stream = await relay.listen();
  tt.after(() => stream.close());
  await stream.settle(1);
  assert.equal(await stream.waitForEnd(3000), true, "the connection ended itself and the shell reopens");
  assert.equal(relay.edge.streamsFor(relay.t), 0);
});

test("a row says whether a quiet window is open, so a tray knows to stay silent", async (tt) => {
  // The desktop transport honoured neither switch: `project()` sent a frame for every card whatever
  // the per-kind switch said (it only decorated the row `muted`) and never consulted quiet hours at
  // all, while `deliver()` on the vendor path refuses a muted kind and holds a quiet one. One
  // customer, one set of switches, two different answers -- and the wire gave the shell no way to do
  // it itself, because nothing anywhere on either surface said a window was in force. Measured on the
  // R750 2026-09-10: a pending frame with quietHours on 15 to 18 at UTC hour 15 carried 15 keys and
  // none of them matched /quiet/i.
  const relay = await standUp({ roster: ROSTER, tail: () => [HANDOFF, WIDGET] });
  tt.after(() => relay.close());
  await relay.ask("POST", "/push/devices", { platform: "desktop", token: "a-device-id", deviceId: "mac-1" });

  // Nothing set: no window, and the fields say so rather than being absent.
  const open = await relay.ask("GET", "/push/pending");
  assert.equal(open.body.cards[0].quiet, false);
  assert.equal(open.body.cards[0].quietUntil, 0);

  // The window that covers THIS hour, whichever hour the suite runs in, with the offset at zero so
  // the local hour is the UTC one. A fixed 0-to-23 window is open for 23 hours a day and red for one.
  const hour = new Date().getUTCHours();
  await relay.ask("PUT", "/push/settings", { kinds: { widget: false }, quietHours: { on: true, from: hour, to: (hour + 1) % 24 }, utcOffsetMinutes: 0 });
  const held = await relay.ask("GET", "/push/pending");
  const row = held.body.cards.find((card) => card.kind === "box-handoff");
  assert.equal(row.quiet, true, "the caller's window is open, so a phone would have been held");
  assert.ok(row.quietUntil > Date.now(), "and the wire says when it ends");
  assert.equal(row.muted, false, "this kind's own switch is separate from the window");
  assert.equal(held.body.cards.find((card) => card.kind === "widget").muted, true);
  assert.equal(held.body.badge, 2, "and neither switch changes the badge");

  // The stream carries the same row, which is the whole point of there being one row shape.
  const stream = await relay.listen();
  tt.after(() => stream.close());
  const frames = await stream.settle(2);
  const framed = frames.map((frame) => frame.payload).find((card) => card.kind === "box-handoff");
  assert.equal(framed.quiet, true);
  assert.equal(framed.quietUntil, row.quietUntil);
  assert.equal(frames.length, 2, "every pending card still arrives: this stream is the list, not the alert");
});
