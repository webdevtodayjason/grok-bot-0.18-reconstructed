/**
 * VOICE-1 item A1: the RFC 6455 codec.
 *
 * This is the one piece of the wave with NO precedent in this tree -- the VNC route pipes raw bytes
 * to websockify and never parses a frame, and the magic GUID appears nowhere in ui/, cp/, scripts/
 * or tests/ -- and a framing bug here is a wedged socket carrying a live microphone. So the codec
 * is tested two ways and both of them matter:
 *
 *   1. against CRAFTED BYTES, for the cases a cooperative peer will not produce on demand (a
 *      64-bit length header, a frame sliced across two TCP reads, a continuation run).
 *   2. against `ws` AS THE REFERENCE PEER ON BOTH SIDES: a real ws client talks to a server that is
 *      nothing but this codec, and a raw socket feeds this codec's own frames into a real ws server.
 *      A codec that only ever met itself would agree with itself about a bug.
 *
 * This test is what caught the first bug in this wave: the GUID was written from memory as
 * ...-95CA-5AB0DC85B11D, one character shifted out of the last group, and every handshake it
 * computed was wrong. The RFC's own example pair is the first assertion below for that reason.
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import WebSocketClient from "ws";
import {
  FrameReader, MAX_MESSAGE_BYTES, OPCODE, VoiceFrameError,
  decodeClose, decodeFrames, encodeClose, encodeFrame, handshakeResponse, wrapBrowserSocket, wsAccept,
} from "../ui/voice-edge.mjs";

/** One masked client frame, built by hand the way a browser builds it. */
function maskedFrame(opcode, payload, mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])) {
  const body = Buffer.from(payload);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3];
  const head = body.length < 126 ? Buffer.alloc(2) : body.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (body.length < 126) head[1] = 0x80 | body.length;
  else if (body.length < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(body.length, 2); }
  else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, mask, masked]);
}

/** The same, but with fin clear and an explicit opcode, for a continuation run. */
function maskedPiece(opcode, payload, fin) {
  const frame = maskedFrame(opcode, payload);
  if (!fin) frame[0] &= 0x7f;
  return frame;
}

test("wsAccept matches the RFC's own example, which is what a real browser checks", () => {
  // RFC 6455 section 1.3. If this line is wrong, every handshake is wrong and every browser reports
  // a generic failure with no clue which end was at fault.
  assert.equal(wsAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("the handshake answer is a 101 that declines permessage-deflate", () => {
  const answer = handshakeResponse("dGhlIHNhbXBsZSBub25jZQ==");
  assert.match(answer, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(answer, /\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
  assert.match(answer, /\r\n\r\n$/);
  // An extension offered and not acknowledged is not in force. A compressed frame this codec did
  // not expect would be indistinguishable from a framing bug.
  assert.ok(!/sec-websocket-extensions/i.test(answer), "no extension is ever acknowledged");
  assert.ok(!/sec-websocket-protocol/i.test(answer), "no subprotocol is echoed: a key must never travel as one");
});

test("a masked text frame decodes, and an unmasked one encodes", () => {
  const { frames, rest } = decodeFrames(maskedFrame(OPCODE.text, Buffer.from("Hello", "utf8")));
  assert.equal(frames.length, 1);
  assert.equal(rest.length, 0);
  assert.equal(frames[0].opcode, OPCODE.text);
  assert.equal(frames[0].masked, true);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].payload.toString("utf8"), "Hello");
  // Outbound is never masked: that is the server's half of the rule.
  const out = encodeFrame(OPCODE.text, Buffer.from("Hello", "utf8"));
  assert.equal(out[0], 0x81);
  assert.equal(out[1] & 0x80, 0, "a server frame is unmasked");
  assert.equal(out.subarray(2).toString("utf8"), "Hello");
});

test("a 200 KB binary payload fragmented across three continuation frames reassembles byte-identical", () => {
  // Audio WILL fragment. A reader that dropped the continuation run would hand the provider a
  // third of every sentence and the model would answer something plausible about nothing.
  const whole = Buffer.alloc(200 * 1024);
  for (let i = 0; i < whole.length; i += 1) whole[i] = (i * 31 + 7) & 0xff;
  const a = whole.subarray(0, 70 * 1024);
  const b = whole.subarray(70 * 1024, 150 * 1024);
  const c = whole.subarray(150 * 1024);
  const reader = new FrameReader();
  assert.equal(reader.push(maskedPiece(OPCODE.binary, a, false)).length, 0);
  assert.equal(reader.push(maskedPiece(OPCODE.continuation, b, false)).length, 0);
  const done = reader.push(maskedPiece(OPCODE.continuation, c, true));
  assert.equal(done.length, 1);
  assert.equal(done[0].opcode, OPCODE.binary, "the run keeps the FIRST frame's opcode");
  assert.equal(done[0].payload.byteLength, whole.byteLength);
  assert.ok(done[0].payload.equals(whole), "byte-identical, not merely the right length");
});

test("a 64-bit length header is read", () => {
  const payload = Buffer.alloc(70 * 1024, 0x5a);
  const frame = maskedFrame(OPCODE.binary, payload);
  assert.equal(frame[1] & 0x7f, 127, "this really is the 64-bit form");
  const { frames } = decodeFrames(frame);
  assert.equal(frames.length, 1);
  assert.ok(frames[0].payload.equals(payload));
});

test("a 16-bit length header is read", () => {
  const payload = Buffer.alloc(4800, 0x11);
  const frame = maskedFrame(OPCODE.binary, payload);
  assert.equal(frame[1] & 0x7f, 126, "this really is the 16-bit form");
  const { frames } = decodeFrames(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.byteLength, 4800);
});

test("a frame split across two TCP reads is held and then completed", () => {
  const frame = maskedFrame(OPCODE.text, Buffer.from("a sentence that arrives in two pieces", "utf8"));
  for (const cut of [1, 2, 3, 5, 6, 9, frame.length - 1]) {
    const first = decodeFrames(frame.subarray(0, cut));
    assert.equal(first.frames.length, 0, `nothing is decoded from the first ${cut} bytes`);
    assert.equal(first.rest.length, cut, "and every byte is kept for the next read");
    const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(cut)]));
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0].payload.toString("utf8"), "a sentence that arrives in two pieces");
  }
  // And through the stateful reader, which is what the socket actually uses.
  const reader = new FrameReader();
  assert.equal(reader.push(frame.subarray(0, 7)).length, 0);
  const out = reader.push(frame.subarray(7));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString("utf8"), "a sentence that arrives in two pieces");
});

test("two frames in one read both come out, and a trailing partial is kept", () => {
  const one = maskedFrame(OPCODE.text, Buffer.from("one", "utf8"));
  const two = maskedFrame(OPCODE.text, Buffer.from("two", "utf8"));
  const three = maskedFrame(OPCODE.text, Buffer.from("three", "utf8"));
  const { frames, rest } = decodeFrames(Buffer.concat([one, two, three.subarray(0, 4)]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.payload.toString("utf8")), ["one", "two"]);
  assert.equal(rest.length, 4);
});

test("a close frame carries a code AND a reason, both ways", () => {
  // The page reads event.reason. A close with no reason is the same void answer as a dead socket.
  const frame = encodeClose(1000, "the person pressed the button");
  assert.equal(frame[0], 0x88, "fin set, opcode close");
  assert.equal(frame[1] & 0x80, 0, "a server close is unmasked");
  const payload = frame.subarray(2);
  assert.deepEqual(decodeClose(payload), { code: 1000, reason: "the person pressed the button" });
  // And the same bytes coming the other way, masked, the way a browser sends its own close.
  const { frames } = decodeFrames(maskedFrame(OPCODE.close, payload));
  assert.equal(frames[0].opcode, OPCODE.close);
  assert.deepEqual(decodeClose(frames[0].payload), { code: 1000, reason: "the person pressed the button" });
  // A close with no payload at all is 1005 and not a crash.
  assert.deepEqual(decodeClose(Buffer.alloc(0)), { code: 1005, reason: "" });
});

test("an extension bit and an oversized frame are protocol errors, not silent reads", () => {
  const frame = maskedFrame(OPCODE.text, Buffer.from("x", "utf8"));
  frame[0] |= 0x40;
  assert.throws(() => decodeFrames(frame), VoiceFrameError);
  const huge = Buffer.alloc(10);
  huge[0] = 0x82;
  huge[1] = 0x80 | 127;
  huge.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2);
  assert.throws(() => decodeFrames(huge), (error) => error instanceof VoiceFrameError && error.code === 1009);
});

test("a continuation with nothing to continue, and a new message mid-run, are both refused", () => {
  const reader = new FrameReader();
  assert.throws(() => reader.push(maskedPiece(OPCODE.continuation, Buffer.from("x"), true)), VoiceFrameError);
  const fresh = new FrameReader();
  fresh.push(maskedPiece(OPCODE.binary, Buffer.from("a"), false));
  assert.throws(() => fresh.push(maskedPiece(OPCODE.text, Buffer.from("b"), true)), VoiceFrameError);
});

// ---- ws as the reference peer, both directions ---------------------------------------------------

/** A server that is nothing but this codec, so a real ws client is the judge of it. */
function serveWithOurCodec(onSocket) {
  const server = net.createServer();
  server.on("connection", (socket) => {
    let head = "";
    const onData = (chunk) => {
      head += String(chunk);
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
      onSocket(socket, key);
    };
    socket.on("data", onData);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

test("a real ws client completes the handshake this codec writes, and both directions survive", async () => {
  const seen = { binary: [], json: [], wrapped: null };
  const { server, port } = await serveWithOurCodec((socket, key) => {
    socket.write(handshakeResponse(key));
    seen.wrapped = wrapBrowserSocket(socket, {
      onBinary: (payload) => { seen.binary.push(payload); },
      onJson: (value) => { seen.json.push(value); },
    });
    // A 200 KB write from our encoder, which the client must read as ONE message.
    seen.wrapped.sendBinary(Buffer.alloc(200 * 1024, 0x7f));
    seen.wrapped.sendJson({ t: "ready", provider: "stub" });
  });
  const settle = () => new Promise((resolve) => { const timer = setTimeout(resolve, 25); timer.unref(); });
  const client = new WebSocketClient(`ws://127.0.0.1:${port}/voice/socket`);
  try {
    const inbound = [];
    const pong = new Promise((resolve) => client.on("pong", (data) => resolve(String(data))));
    const closed = new Promise((resolve) => client.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
    client.on("message", (data, isBinary) => inbound.push(isBinary ? Buffer.from(data) : JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
      const timer = setTimeout(() => reject(new Error("the ws client never opened against our handshake")), 4000);
      timer.unref();
    });
    // Up: a masked binary frame and a masked text frame from a real browser-grade client.
    client.send(Buffer.alloc(4800, 0x21));
    client.send(JSON.stringify({ t: "held", frames: 3, ms: 300 }));
    client.ping(Buffer.from("are you there"));
    for (let i = 0; i < 80 && (seen.binary.length === 0 || seen.json.length === 0 || inbound.length < 2); i += 1) await settle();
    assert.equal(seen.binary.length, 1, "our decoder read the client's masked binary frame");
    assert.equal(seen.binary[0].byteLength, 4800);
    assert.deepEqual(seen.json[0], { t: "held", frames: 3, ms: 300 });
    assert.equal(await pong, "are you there", "a ping gets a pong carrying the same payload");
    const big = inbound.find((value) => Buffer.isBuffer(value));
    assert.ok(big != null, "ws read our 200 KB frame");
    assert.equal(big.byteLength, 200 * 1024, "as ONE message, not several");
    assert.deepEqual(inbound.find((value) => !Buffer.isBuffer(value)), { t: "ready", provider: "stub" });
    // And the close: ws reports the code and the reason our encoder wrote, which is what the page
    // reads off event.reason when it tells the person what happened.
    seen.wrapped.bye("the person pressed the button");
    assert.deepEqual(await closed, { code: 1000, reason: "the person pressed the button" });
  } finally {
    client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a real ws CLIENT reads frames this codec encodes, at every length form", async () => {
  // This codec is only ever the SERVER half: the relay answers the browser's upgrade and the
  // browser is always the client. So the encoder is deliberately unmasked, which is the rule for a
  // server frame -- and a ws SERVER is right to refuse it with WS_ERR_EXPECTED_MASK, because from
  // its side an unmasked frame means a client that broke the spec. Pointing this test at a ws
  // client is not a way around that refusal; it is the only direction these bytes ever travel.
  const got = [];
  const { server, port } = await serveWithOurCodec((socket, key) => {
    socket.write(handshakeResponse(key));
    // Straight onto the wire, bypassing the wrapper, so what is under test is encodeFrame alone.
    socket.write(encodeFrame(OPCODE.text, Buffer.from("short", "utf8")));
    socket.write(encodeFrame(OPCODE.binary, Buffer.alloc(4800, 0x33)));
    socket.write(encodeFrame(OPCODE.binary, Buffer.alloc(90 * 1024, 0x44)));
    socket.write(encodeFrame(OPCODE.ping, Buffer.from("tick", "utf8")));
  });
  const client = new WebSocketClient(`ws://127.0.0.1:${port}/voice/socket`);
  try {
    client.on("message", (data, isBinary) => got.push(isBinary ? Buffer.from(data) : String(data)));
    client.on("ping", (data) => got.push(`ping:${String(data)}`));
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
      const timer = setTimeout(() => reject(new Error("the ws client never opened")), 4000);
      timer.unref();
    });
    for (let i = 0; i < 120 && got.length < 4; i += 1) await new Promise((r) => { const timer = setTimeout(r, 25); timer.unref(); });
    assert.equal(got[0], "short", "a 7-bit length frame");
    assert.equal(got[1].byteLength, 4800, "a 16-bit length frame");
    assert.equal(got[2].byteLength, 90 * 1024, "a 64-bit length frame");
    assert.equal(got[3], "ping:tick", "and a ping, carrying its payload");
  } finally {
    client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a ws server refuses this encoder's unmasked frames, which is the rule it is written to", async () => {
  // The flip side of the test above, pinned so nobody later "fixes" encodeFrame by masking it: a
  // masked server frame is just as wrong, and a browser would refuse it the same way.
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const { port } = wss.address();
  // Registered BEFORE anything connects. Attached after the upgrade, this handler would miss the
  // connection event it is waiting for and the test would hang rather than fail.
  const refusal = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no refusal arrived"), 8000);
    timer.unref();
    wss.on("connection", (ws) => ws.on("error", (error) => { clearTimeout(timer); resolve(String(error?.code ?? error?.message ?? error)); }));
  });
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  socket.write([
    "GET /voice/socket HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket",
    "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "", "",
  ].join("\r\n"));
  try {
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(""), 8000);
      timer.unref();
      let head = "";
      socket.on("data", (chunk) => { head += String(chunk); if (head.includes("\r\n\r\n")) { clearTimeout(timer); resolve(head); } });
    });
    // ws's own accept for the RFC's key, which is the third independent check of that GUID.
    assert.ok(answer.includes(`Sec-WebSocket-Accept: ${wsAccept(key)}`), "ws computes the same accept this codec does");
    socket.write(encodeFrame(OPCODE.text, Buffer.from("unmasked", "utf8")));
    assert.equal(await refusal, "WS_ERR_EXPECTED_MASK");
  } finally {
    socket.destroy();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
});
