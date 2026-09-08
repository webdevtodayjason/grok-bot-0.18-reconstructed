// A WebSocket client small enough to ship, written against RFC 6455 directly.
//
// Why not a library: this module runs inside a box, out of the read-only runtime mount, where
// there is no npm install and no node_modules. The box's node is 20.19, whose global WebSocket is
// still behind a flag, so there is nothing to borrow from the runtime either. The other option was
// to vendor playwright-core, which is 12 MB of code to open one loopback socket. This file is the
// whole dependency, and it only ever talks to Chrome on 127.0.0.1, so there is no TLS and no proxy
// handling in it.
//
// The frame codec is exported on its own so tests can check it against the byte vectors printed in
// RFC 6455 section 5.7 rather than against itself.

import net from "node:net";
import crypto from "node:crypto";

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
});

/** The Sec-WebSocket-Accept value a server owes for a given Sec-WebSocket-Key. */
export function acceptKey(clientKey) {
  return crypto.createHash("sha1").update(clientKey + HANDSHAKE_GUID).digest("base64");
}

/**
 * One WebSocket frame on the wire. `maskKey` is only for tests that need a fixed key; real client
 * frames get a fresh random one, which is what the spec requires of a client.
 */
export function encodeFrame(opcode, payload, options = {}) {
  const fin = options.fin !== false;
  const mask = options.mask === true;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");
  const length = body.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, body]);

  header[1] |= 0x80;
  const key = options.maskKey === undefined ? crypto.randomBytes(4) : Buffer.from(options.maskKey);
  if (key.length !== 4) throw new Error("a websocket mask key is four bytes");
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

/**
 * Feed it bytes, take frames out. Keeps one buffer with a read offset and only compacts when the
 * consumed part gets big, so a multi-megabyte screenshot does not turn into quadratic copying.
 */
export class FrameReader {
  #buffer = Buffer.alloc(0);
  #offset = 0;

  push(chunk) {
    this.#compact();
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  #compact() {
    if (this.#offset === 0) return;
    if (this.#offset < 1 << 20 && this.#offset < this.#buffer.length) return;
    this.#buffer = this.#buffer.subarray(this.#offset);
    this.#offset = 0;
  }

  /** The next complete frame, or undefined when more bytes are needed. */
  next() {
    const available = this.#buffer.length - this.#offset;
    if (available < 2) return undefined;
    const first = this.#buffer[this.#offset];
    const second = this.#buffer[this.#offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = this.#offset + 2;

    if (length === 126) {
      if (this.#buffer.length - cursor < 2) return undefined;
      length = this.#buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (this.#buffer.length - cursor < 8) return undefined;
      const big = this.#buffer.readBigUInt64BE(cursor);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("the browser sent a frame too large to read");
      length = Number(big);
      cursor += 8;
    }

    let key;
    if (masked) {
      if (this.#buffer.length - cursor < 4) return undefined;
      key = this.#buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (this.#buffer.length - cursor < length) return undefined;

    let payload = this.#buffer.subarray(cursor, cursor + length);
    if (masked) {
      const unmasked = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ key[i % 4];
      payload = unmasked;
    }
    this.#offset = cursor + length;
    return { fin, opcode, payload };
  }
}

/** Joins continuation frames back into whole messages, and answers pings. */
export class MessageAssembler {
  #opcode = null;
  #parts = [];

  /** Returns a completed message, a pong to send back, or undefined. */
  accept(frame) {
    if (frame.opcode === OPCODE.ping) return { pong: frame.payload };
    if (frame.opcode === OPCODE.pong) return undefined;
    if (frame.opcode === OPCODE.close) return { close: true };

    if (frame.opcode !== OPCODE.continuation) {
      this.#opcode = frame.opcode;
      this.#parts = [frame.payload];
    } else {
      if (this.#opcode === null) throw new Error("the browser sent a continuation with nothing to continue");
      this.#parts.push(frame.payload);
    }
    if (!frame.fin) return undefined;

    const opcode = this.#opcode;
    const body = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
    this.#opcode = null;
    this.#parts = [];
    return { message: opcode === OPCODE.text ? body.toString("utf8") : body, binary: opcode === OPCODE.binary };
  }
}

export class WebSocketConnection {
  #socket;
  #reader = new FrameReader();
  #assembler = new MessageAssembler();
  #messageHandlers = new Set();
  #closeHandlers = new Set();
  #closed = false;

  constructor(socket, leftover) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#onClose(error.message));
    socket.on("close", () => this.#onClose("the browser closed the connection"));
    if (leftover !== undefined && leftover.length > 0) this.#onData(leftover);
  }

  get closed() {
    return this.#closed;
  }

  onMessage(handler) {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onClose(handler) {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  send(text) {
    if (this.#closed) throw new Error("the connection to the browser is already closed");
    this.#socket.write(encodeFrame(OPCODE.text, text, { mask: true }));
  }

  close() {
    if (this.#closed) return;
    try {
      this.#socket.write(encodeFrame(OPCODE.close, Buffer.alloc(0), { mask: true }));
    } catch {
      // The socket is already gone; destroying it below is all that is left to do.
    }
    this.#socket.destroy();
    this.#onClose("closed");
  }

  #onData(chunk) {
    this.#reader.push(chunk);
    for (;;) {
      let frame;
      try {
        frame = this.#reader.next();
      } catch (error) {
        this.#onClose(error.message);
        this.#socket.destroy();
        return;
      }
      if (frame === undefined) return;
      let outcome;
      try {
        outcome = this.#assembler.accept(frame);
      } catch (error) {
        this.#onClose(error.message);
        this.#socket.destroy();
        return;
      }
      if (outcome === undefined) continue;
      if (outcome.pong !== undefined) {
        this.#socket.write(encodeFrame(OPCODE.pong, outcome.pong, { mask: true }));
        continue;
      }
      if (outcome.close === true) {
        this.close();
        return;
      }
      for (const handler of this.#messageHandlers) handler(outcome.message, outcome.binary === true);
    }
  }

  #onClose(reason) {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler(reason);
  }
}

/** Opens a ws:// connection. Loopback only, which is the only place a box's Chrome listens. */
export function connectWebSocket(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:") throw new Error(`this driver only speaks ws://, not ${parsed.protocol}//`);
  const key = crypto.randomBytes(16).toString("base64");
  const expected = acceptKey(key);
  const path = `${parsed.pathname}${parsed.search}`;
  const port = Number(parsed.port || 80);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, connection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve(connection);
    };
    const timer = setTimeout(
      () => finish(new Error("the browser did not answer the connection in time")),
      timeoutMs,
    );

    const socket = net.connect({ host: parsed.hostname, port });
    socket.setNoDelay(true);
    socket.on("error", (error) => finish(new Error(`could not reach the browser: ${error.message}`)));

    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 65536) finish(new Error("the browser sent a reply that made no sense"));
        return;
      }
      socket.removeListener("data", onData);
      const headerText = head.subarray(0, end).toString("latin1");
      const leftover = head.subarray(end + 4);
      const statusLine = headerText.split("\r\n", 1)[0];
      if (!/^HTTP\/1\.1 101/.test(statusLine)) {
        finish(new Error(`the browser refused the connection: ${statusLine}`));
        return;
      }
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(`\r\n${headerText}`);
      if (accept === null || accept[1] !== expected) {
        finish(new Error("the browser's handshake did not check out"));
        return;
      }
      finish(null, new WebSocketConnection(socket, leftover));
    };

    socket.on("data", onData);
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.hostname}:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
  });
}
