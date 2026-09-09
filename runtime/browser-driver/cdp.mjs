// The Chrome DevTools Protocol, over the socket in ws.mjs.
//
// One connection to the browser endpoint, flat sessions for the tabs. Flat sessions mean a command
// carries a sessionId at the top level and events come back with one, so a single socket drives the
// browser and every tab on it without the old Target.sendMessageToTarget envelope.
//
// Every send has a deadline. Nothing here waits forever, because a hung browser is the failure this
// driver is most likely to meet and "it just stopped" is not an error a person can act on.

import { connectWebSocket } from "./ws.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

/** GET a JSON document from the browser's HTTP side (/json/version, /json/list). */
export async function browserJson(port, path, timeoutMs = 5000) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`the browser answered ${response.status} for ${path}`);
  return await response.json();
}

/** True when something on this port answers as a browser we can drive. */
export async function cdpAlive(port, timeoutMs = 1500) {
  try {
    const version = await browserJson(port, "/json/version", timeoutMs);
    return typeof version?.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

export class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closedReason = null;

  constructor(socket) {
    this.#socket = socket;
    socket.onMessage((text) => this.#onMessage(text));
    socket.onClose((reason) => this.#onClose(reason));
  }

  static async open(port, options = {}) {
    const version = await browserJson(port, "/json/version", options.timeoutMs ?? 5000);
    const url = version?.webSocketDebuggerUrl;
    if (typeof url !== "string") throw new Error(`nothing on port ${port} looks like a browser we can drive`);
    const socket = await connectWebSocket(url, { timeoutMs: options.timeoutMs ?? 10000 });
    const connection = new CdpConnection(socket);
    connection.browserVersion = typeof version.Browser === "string" ? version.Browser : "unknown";
    return connection;
  }

  /**
   * CLOUD-BROWSER-1. Attach to a websocket endpoint somebody already resolved for us.
   *
   * `open` above starts at a loopback PORT and asks /json/version for the socket. A cloud browser
   * has no loopback port and no reachable /json/version: the vendor hands out one wss:// URL whose
   * path or query IS the session credential. So this takes the URL and nothing else, and everything
   * downstream -- the flat sessions, the deadlines, the event fan-out -- is the same object doing
   * the same work. The browser version is asked for over the socket rather than over HTTP, and a
   * browser that will not answer that question is still a browser we can drive, so it is not fatal.
   */
  static async attachTo(webSocketDebuggerUrl, options = {}) {
    const url = String(webSocketDebuggerUrl ?? "").trim();
    if (url.length === 0) throw new Error("no browser endpoint was given to attach to");
    const socket = await connectWebSocket(url, { timeoutMs: options.timeoutMs ?? 15000 });
    const connection = new CdpConnection(socket);
    connection.browserVersion = "unknown";
    try {
      const version = await connection.send("Browser.getVersion", {}, { timeoutMs: options.timeoutMs ?? 10000 });
      if (typeof version?.product === "string") connection.browserVersion = version.product;
    } catch {
      // A browser that will not name itself still drives. Nothing below reads this but the log.
    }
    return connection;
  }

  get closed() {
    return this.#closedReason !== null;
  }

  /** Send a command and wait for its answer. Rejects with the browser's own words on a protocol error. */
  send(method, params = {}, options = {}) {
    if (this.#closedReason !== null) return Promise.reject(new Error(this.#closedReason));
    const id = this.#nextId;
    this.#nextId += 1;
    const message = { id, method, params };
    if (options.sessionId !== undefined) message.sessionId = options.sessionId;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // No method name in the sentence. "Page.navigate" in front of a person is jargon, and this
        // message is handed to the model and repeated. The name stays on the error for the log.
        const failure = new Error(`the browser did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
        failure.cdpMethod = method;
        reject(failure);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(`could not send ${method} to the browser: ${error.message}`));
      }
    });
  }

  /** Subscribe to a CDP event. Returns the unsubscribe function. */
  on(method, handler) {
    let handlers = this.#listeners.get(method);
    if (handlers === undefined) {
      handlers = new Set();
      this.#listeners.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  /** Wait for one event that passes `predicate`, or give up. Never rejects on timeout: resolves undefined. */
  waitFor(method, predicate, timeoutMs) {
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      const off = this.on(method, (params, sessionId) => {
        if (predicate === undefined || predicate(params, sessionId) === true) done(params);
      });
    });
  }

  close() {
    this.#socket.close();
    this.#onClose("the connection to the browser was closed");
  }

  #onMessage(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (payload.id !== undefined) {
      const waiting = this.#pending.get(payload.id);
      if (waiting === undefined) return;
      this.#pending.delete(payload.id);
      clearTimeout(waiting.timer);
      if (payload.error !== undefined) {
        const detail = typeof payload.error?.message === "string" ? payload.error.message : "the browser said no";
        waiting.reject(new Error(`${waiting.method} failed: ${detail}`));
        return;
      }
      waiting.resolve(payload.result ?? {});
      return;
    }
    if (typeof payload.method !== "string") return;
    const handlers = this.#listeners.get(payload.method);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) handler(payload.params ?? {}, payload.sessionId);
  }

  #onClose(reason) {
    if (this.#closedReason !== null) return;
    this.#closedReason = reason;
    for (const [, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}
