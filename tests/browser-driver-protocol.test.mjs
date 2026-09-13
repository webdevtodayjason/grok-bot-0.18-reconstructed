// BROWSER-1. The wire the driver speaks: RFC 6455 frames, then CDP over them.
//
// The driver ships its own WebSocket because it runs inside a box out of a read-only mount, where
// there is no npm install and the box's node 20 keeps its global WebSocket behind a flag. Shipping
// a socket implementation means owning it, so this file checks the codec against the byte vectors
// printed in RFC 6455 section 5.7 rather than against itself, and then runs the real client against
// a fake browser that speaks just enough CDP to be wrong in the ways a real one is: an error result,
// a session-routed event, a message too big for one frame, a command that never gets answered.

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  FrameReader,
  MessageAssembler,
  OPCODE,
  acceptKey,
  connectWebSocket,
  encodeFrame,
} from "../runtime/browser-driver/ws.mjs";
import { CdpConnection, browserJson, cdpAlive } from "../runtime/browser-driver/cdp.mjs";
import { candidatePorts, displayNumber, portForDisplay } from "../runtime/browser-driver/chrome.mjs";

test("the handshake answer matches the one printed in RFC 6455", () => {
  // RFC 6455 section 1.3, the worked example.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("frames match the byte vectors in RFC 6455 section 5.7", () => {
  assert.deepEqual(
    [...encodeFrame(OPCODE.text, "Hello")],
    [0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f],
    "a single unmasked text frame",
  );
  assert.deepEqual(
    [...encodeFrame(OPCODE.text, "Hello", { mask: true, maskKey: [0x37, 0xfa, 0x21, 0x3d] })],
    [0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58],
    "the same frame masked with the RFC's key",
  );
  assert.deepEqual(
    [...encodeFrame(OPCODE.binary, Buffer.alloc(256)).subarray(0, 4)],
    [0x82, 0x7e, 0x01, 0x00],
    "256 bytes uses the two byte length",
  );
  assert.deepEqual(
    [...encodeFrame(OPCODE.binary, Buffer.alloc(65536)).subarray(0, 10)],
    [0x82, 0x7f, 0, 0, 0, 0, 0, 0x01, 0x00, 0x00],
    "65536 bytes uses the eight byte length",
  );
  assert.throws(() => encodeFrame(OPCODE.text, "x", { mask: true, maskKey: [1, 2] }), /four bytes/);
});

test("the reader puts a frame back together however the bytes arrive", () => {
  const frame = encodeFrame(OPCODE.text, "Hello", { mask: true, maskKey: [0x37, 0xfa, 0x21, 0x3d] });
  const reader = new FrameReader();
  for (const byte of frame) {
    assert.equal(reader.next(), undefined, "nothing comes out until the frame is whole");
    reader.push(Buffer.from([byte]));
  }
  const read = reader.next();
  assert.equal(read.payload.toString("utf8"), "Hello", "the mask comes back off");
  assert.equal(read.fin, true);
  assert.equal(reader.next(), undefined);
});

test("the reader keeps up with a message far past the two byte length", () => {
  const big = "x".repeat(200000);
  const reader = new FrameReader();
  reader.push(encodeFrame(OPCODE.text, big));
  reader.push(encodeFrame(OPCODE.text, "after"));
  assert.equal(reader.next().payload.length, 200000);
  assert.equal(reader.next().payload.toString("utf8"), "after");
});

test("continuations rejoin, and a ping is answered rather than delivered", () => {
  const assembler = new MessageAssembler();
  assert.equal(assembler.accept({ fin: false, opcode: OPCODE.text, payload: Buffer.from("{\"id\":") }), undefined);
  const done = assembler.accept({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from("1}") });
  assert.equal(done.message, '{"id":1}');

  const ping = assembler.accept({ fin: true, opcode: OPCODE.ping, payload: Buffer.from("hi") });
  assert.equal(ping.pong.toString("utf8"), "hi");
  assert.equal(assembler.accept({ fin: true, opcode: OPCODE.close, payload: Buffer.alloc(0) }).close, true);
});

// A browser that is not a browser: /json/version, a websocket, and a handful of CDP replies.
async function fakeBrowser(handle) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        Browser: "Chrome/151.0.7922.169",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
      }));
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    const key = request.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const reader = new FrameReader();
    const assembler = new MessageAssembler();
    const reply = (payload, options = {}) => {
      const body = JSON.stringify(payload);
      if (options.fragment !== true) {
        socket.write(encodeFrame(OPCODE.text, body));
        return;
      }
      const half = Math.floor(body.length / 2);
      socket.write(encodeFrame(OPCODE.text, body.slice(0, half), { fin: false }));
      socket.write(encodeFrame(OPCODE.continuation, body.slice(half)));
    };
    socket.on("data", (chunk) => {
      reader.push(chunk);
      for (;;) {
        const frame = reader.next();
        if (frame === undefined) return;
        const outcome = assembler.accept(frame);
        if (outcome?.pong !== undefined) {
          socket.write(encodeFrame(OPCODE.pong, outcome.pong));
          continue;
        }
        if (outcome?.message === undefined) continue;
        handle(JSON.parse(outcome.message), reply, socket);
      }
    });
    socket.on("error", () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("the http side of the browser is read the way the driver reads it", async () => {
  const browser = await fakeBrowser(() => {});
  try {
    const version = await browserJson(browser.port, "/json/version");
    assert.equal(version.Browser, "Chrome/151.0.7922.169");
    assert.equal(await cdpAlive(browser.port), true);
    await assert.rejects(browserJson(browser.port, "/json/list"), /answered 404/);
  } finally {
    await browser.stop();
  }
});

test("nothing on a dead port is a plain no, not a hang", async () => {
  const idle = await fakeBrowser(() => {});
  const port = idle.port;
  await idle.stop();
  assert.equal(await cdpAlive(port, 1000), false);
});

test("commands, results and errors travel by id", async () => {
  const browser = await fakeBrowser((message, reply) => {
    if (message.method === "Target.getTargets") {
      reply({ id: message.id, result: { targetInfos: [{ targetId: "t1", type: "page", url: "about:blank", title: "" }] } });
      return;
    }
    if (message.method === "Page.navigate") {
      // Answered out of order on purpose: correlation is by id, not by arrival.
      setTimeout(() => reply({ id: message.id, result: { frameId: "f1" } }), 40);
      return;
    }
    if (message.method === "Runtime.evaluate") {
      reply({ id: message.id, result: { result: { value: message.params.expression.length } } });
      return;
    }
    reply({ id: message.id, error: { code: -32601, message: "'Nope.doThing' wasn't found" } });
  });

  try {
    const connection = await CdpConnection.open(browser.port);
    assert.equal(connection.browserVersion, "Chrome/151.0.7922.169");

    const [navigate, evaluate, targets] = await Promise.all([
      connection.send("Page.navigate", { url: "https://example.com" }),
      connection.send("Runtime.evaluate", { expression: "1+1" }),
      connection.send("Target.getTargets"),
    ]);
    assert.equal(navigate.frameId, "f1", "the slow answer still found its own caller");
    assert.equal(evaluate.result.value, 3);
    assert.equal(targets.targetInfos[0].targetId, "t1");

    await assert.rejects(
      connection.send("Nope.doThing"),
      /Nope\.doThing failed: 'Nope\.doThing' wasn't found/,
      "a protocol error comes back in the browser's own words",
    );
    connection.close();
  } finally {
    await browser.stop();
  }
});

test("events reach the listener with the session they belong to", async () => {
  const browser = await fakeBrowser((message, reply, socket) => {
    if (message.method === "Target.attachToTarget") {
      reply({ id: message.id, result: { sessionId: "S1" } });
      socket.write(encodeFrame(OPCODE.text, JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" })));
      socket.write(encodeFrame(OPCODE.text, JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 2 }, sessionId: "S2" })));
      return;
    }
    reply({ id: message.id, result: {} });
  });

  try {
    const connection = await CdpConnection.open(browser.port);
    const seen = [];
    connection.on("Page.loadEventFired", (params, sessionId) => seen.push([params.timestamp, sessionId]));
    const ours = connection.waitFor("Page.loadEventFired", (_params, sessionId) => sessionId === "S1", 3000);
    // The other tab's event is waited for too. The fake browser writes both frames back to back,
    // but back to back is not the same read: under load the S2 frame lands in a later one, and
    // asserting on `seen` the instant S1 resolves was asserting that a frame nobody waited for had
    // already been parsed. That is what failed once in 3,488 under a full-suite run and never
    // alone. The claim is unchanged -- both events were routed, each with its own session -- and
    // the 3 s deadline still fails a lost event.
    const theirs = connection.waitFor("Page.loadEventFired", (_params, sessionId) => sessionId === "S2", 3000);

    const attached = await connection.send("Target.attachToTarget", { targetId: "t1", flatten: true });
    assert.equal(attached.sessionId, "S1");
    assert.deepEqual(await ours, { timestamp: 1 }, "the other tab's event was not mistaken for ours");
    assert.deepEqual(await theirs, { timestamp: 2 }, "and the other tab's event did arrive, under its own session");
    assert.deepEqual(seen, [[1, "S1"], [2, "S2"]]);
    connection.close();
  } finally {
    await browser.stop();
  }
});

test("a screenshot sized answer survives fragmentation", async () => {
  const image = "A".repeat(300000);
  const browser = await fakeBrowser((message, reply) => {
    reply({ id: message.id, result: { data: image } }, { fragment: true });
  });
  try {
    const connection = await CdpConnection.open(browser.port);
    const shot = await connection.send("Page.captureScreenshot", { format: "jpeg" });
    assert.equal(shot.data.length, 300000, "the whole picture came back across two frames");
    connection.close();
  } finally {
    await browser.stop();
  }
});

test("a command that is never answered gives up in plain words", async () => {
  const browser = await fakeBrowser(() => {});
  try {
    const connection = await CdpConnection.open(browser.port);
    // The sentence carries no CDP method name: it is handed to the model and repeated to a
    // person, and "Page.navigate" in that sentence is jargon. The name rides on the error instead.
    await assert.rejects(
      connection.send("Page.navigate", { url: "https://example.com" }, { timeoutMs: 300 }),
      (error) => {
        assert.match(error.message, /the browser did not answer within 0 seconds/);
        assert.ok(!error.message.includes("Page.navigate"), error.message);
        assert.equal(error.cdpMethod, "Page.navigate");
        return true;
      },
    );
    // waitFor is the other half: it resolves undefined rather than throwing, because a page that
    // never fires load is a page we still want to read.
    assert.equal(await connection.waitFor("Page.loadEventFired", undefined, 200), undefined);
    connection.close();
  } finally {
    await browser.stop();
  }
});

test("a browser that goes away takes the waiting commands with it, and says so", async () => {
  const browser = await fakeBrowser((message, reply, socket) => {
    if (message.method === "Page.navigate") {
      socket.destroy();
      return;
    }
    reply({ id: message.id, result: {} });
  });
  try {
    const connection = await CdpConnection.open(browser.port);
    await assert.rejects(connection.send("Page.navigate", { url: "https://example.com" }), /browser closed the connection/);
    assert.equal(connection.closed, true);
    await assert.rejects(connection.send("Page.enable"), /closed/);
  } finally {
    await browser.stop();
  }
});

test("a handshake that is not a handshake is refused rather than trusted", async () => {
  const server = http.createServer();
  const opened = [];
  server.on("upgrade", (request, socket) => {
    opened.push(socket);
    socket.on("error", () => {});
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      connectWebSocket(`ws://127.0.0.1:${server.address().port}/devtools/browser/fake`, { timeoutMs: 2000 }),
      /handshake did not check out/,
    );
  } finally {
    for (const socket of opened) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the port comes from the display, the way the box's own launcher works it out", () => {
  assert.equal(displayNumber({ DISPLAY: ":10" }), 10);
  assert.equal(displayNumber({ DISPLAY: ":10.0" }), 10);
  assert.equal(displayNumber({}), 1, "no display means the person's own seat");
  assert.equal(portForDisplay(10, {}), 9232, "measured on the box: display :10 is port 9232");
  assert.equal(portForDisplay(10, { SAND_CHROME_REMOTE_DEBUG_PORT: "9444" }), 9444, "the launcher's override wins");
  assert.equal(candidatePorts(10, {})[0], 9232, "the display's own port is tried first");
  assert.ok(candidatePorts(10, {}).includes(9223), "then the neighbours, so a driver on the wrong seat still finds one");
});
