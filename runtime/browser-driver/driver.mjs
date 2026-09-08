// The browser Titan drives: open a page, read it, click a thing, type a thing, take one picture.
//
// It attaches to the browser the box already runs on the person's profile and the person's display,
// in a tab of its own. That matters twice over: the logins are there, and the desktop view keeps
// showing the same window, so a person watching can see what happened and take over. It never opens
// a second window and never closes the browser.
//
// Every action has a deadline of 30 seconds and fails in plain words.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { CdpConnection } from "./cdp.mjs";
import { ensureBrowser } from "./chrome.mjs";
import { analyzePage, TEXT_CAP } from "./page-text.mjs";

export const ACTION_TIMEOUT_MS = 30000;
export const SCREENSHOT_WIDTH = 1280;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stateDirectory(env = process.env) {
  return env.TITANBOT_BROWSER_STATE_DIR ?? "/tmp/.titanbot-browser";
}

function stateFile(port, env = process.env) {
  return path.join(stateDirectory(env), `tab-${port}.json`);
}

function readState(port, env) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(port, env), "utf8"));
    return typeof parsed?.targetId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(port, state, env) {
  try {
    mkdirSync(stateDirectory(env), { recursive: true });
    writeFileSync(stateFile(port, env), JSON.stringify(state));
  } catch {
    // A tab we cannot remember just means the next open makes a new one. Not worth failing over.
  }
}

function forgetState(port, env) {
  try {
    rmSync(stateFile(port, env), { force: true });
  } catch {
    // Same: losing the note is not a failure.
  }
}

async function withDeadline(label, ms, work) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)} seconds and was given up on`)), ms);
  });
  try {
    return await Promise.race([work(), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs in the page. Finds an element by CSS selector first, then by what a person would read on it.
const LOCATE_FUNCTION = `function locate(target, wantsInput) {
  const clean = String(target || "").trim();
  const seen = [];
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const describe = (el) => (el.tagName || "").toLowerCase() + (el.id ? "#" + el.id : "");
  const take = (el) => {
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      label: describe(el),
      text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120),
      tag: (el.tagName || "").toLowerCase(),
    };
  };
  try {
    const direct = document.querySelector(clean);
    if (direct && visible(direct)) return take(direct);
    if (direct) return take(direct);
  } catch (error) {
    // Not a selector. Fall through to reading the page.
  }
  const wanted = clean.toLowerCase();
  const pool = wantsInput
    ? Array.from(document.querySelectorAll("input, textarea, [contenteditable=true], select"))
    : Array.from(document.querySelectorAll("a, button, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], summary, label, li, td"));
  const score = (el) => {
    const labels = [
      el.innerText, el.value, el.placeholder, el.getAttribute("aria-label"),
      el.getAttribute("title"), el.getAttribute("name"), el.getAttribute("id"),
    ];
    if (el.labels && el.labels.length > 0) labels.push(el.labels[0].innerText);
    for (const raw of labels) {
      const candidate = String(raw || "").trim().toLowerCase();
      if (candidate.length === 0) continue;
      if (candidate === wanted) return 3;
      if (candidate.startsWith(wanted)) return 2;
      if (candidate.includes(wanted)) return 1;
    }
    return 0;
  };
  let best = null;
  let bestScore = 0;
  for (const el of pool) {
    const points = score(el) + (visible(el) ? 0.5 : 0);
    if (points > bestScore && points >= 1) {
      best = el;
      bestScore = points;
    }
    if (seen.length < 12 && visible(el)) {
      const label = String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
      if (label.length > 0) seen.push(label.slice(0, 60));
    }
  }
  if (best) return take(best);
  return { found: false, nearby: seen };
}`;

export class BrowserDriver {
  #connection;
  #sessionId = null;
  #targetId = null;
  #port;
  #env;
  #mainFrameId = null;
  #statusByFrame = new Map();

  constructor({ connection, port, env }) {
    this.#connection = connection;
    this.#port = port;
    this.#env = env ?? process.env;
  }

  get port() {
    return this.#port;
  }

  get browserVersion() {
    return this.#connection.browserVersion;
  }

  /** Attach to the box's browser, starting it only if there is not one already. */
  static async attach(options = {}) {
    const env = options.env ?? process.env;
    const { port, started } = await ensureBrowser({ ...options, env });
    const connection = await CdpConnection.open(port, { timeoutMs: options.timeoutMs ?? 10000 });
    const driver = new BrowserDriver({ connection, port, env });
    driver.startedBrowser = started;
    return driver;
  }

  /** Let go of the browser. The browser and the person's tab stay exactly where they are. */
  detach() {
    this.#connection.close();
  }

  async #send(method, params, options = {}) {
    return await this.#connection.send(method, params, { sessionId: this.#sessionId ?? undefined, ...options });
  }

  async #browserSend(method, params, options = {}) {
    return await this.#connection.send(method, params, options);
  }

  async #pageTargets() {
    const { targetInfos } = await this.#browserSend("Target.getTargets", {}, { timeoutMs: 10000 });
    return (targetInfos ?? []).filter((target) => target.type === "page" && !String(target.url).startsWith("devtools://"));
  }

  /** The tab this driver owns, made once and remembered, so repeat calls do not pile up tabs. */
  /** Make a tab of our own in the window already on screen, and remember it. */
  async #newTab() {
    // newWindow is false on purpose: the desktop view shows one browser window and it has to stay
    // one browser window.
    const created = await this.#browserSend(
      "Target.createTarget",
      { url: "about:blank", newWindow: false, background: false },
      { timeoutMs: 15000 },
    );
    writeState(this.#port, { targetId: created.targetId, at: new Date().toISOString() }, this.#env);
    return created.targetId;
  }

  /** Attach to one tab and turn on the two domains every action needs. Throws if it will not answer. */
  async #attach(targetId) {
    const attached = await this.#browserSend("Target.attachToTarget", { targetId, flatten: true }, { timeoutMs: 15000 });
    this.#sessionId = attached.sessionId;
    this.#targetId = targetId;

    this.#connection.on("Network.responseReceived", (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      if (params?.type !== "Document") return;
      this.#statusByFrame.set(params.frameId, params.response?.status ?? 0);
    });

    // 25 seconds, not 10. These are answered by the tab's own renderer, and a renderer busy with a
    // heavy page answers late: measured on grok-bot-local-vm 2026-09-07, a tab left on a YouTube
    // channel could not answer Page.enable inside 10 s, and every action after it failed on a tab
    // that was in fact fine.
    await this.#send("Page.enable", {}, { timeoutMs: 25000 });
    await this.#send("Network.enable", {}, { timeoutMs: 25000 });
    const tree = await this.#send("Page.getFrameTree", {}, { timeoutMs: 15000 });
    this.#mainFrameId = tree?.frameTree?.frame?.id ?? null;
  }

  async #ownTab() {
    if (this.#targetId !== null && this.#sessionId !== null) return this.#targetId;

    const targets = await this.#pageTargets();
    const remembered = readState(this.#port, this.#env);
    const reuse = remembered !== null && targets.some((target) => target.targetId === remembered.targetId)
      ? remembered.targetId
      : null;

    if (reuse === null) {
      const made = await this.#newTab();
      await this.#attach(made);
      return made;
    }

    try {
      await this.#attach(reuse);
      return reuse;
    } catch (error) {
      // The tab we remembered is there but will not talk: a wedged renderer, a crashed tab, a
      // page that never finished. Losing our note costs one new tab; keeping it costs every
      // action from here on, which is what actually happened before this catch existed.
      this.#sessionId = null;
      this.#targetId = null;
      forgetState(this.#port, this.#env);
      const made = await this.#newTab();
      await this.#attach(made);
      return made;
    }
  }

  async #evaluate(expression, options = {}) {
    const result = await this.#send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, ...options },
      { timeoutMs: options.timeoutMs ?? 20000 },
    );
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? "the page rejected it";
      throw new Error(`the page could not do that: ${String(detail).split("\n")[0]}`);
    }
    return result.result?.value;
  }

  async #readPage(cap) {
    const raw = await this.#evaluate(
      `(() => ({
        url: location.href,
        title: document.title || "",
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, 3000000) : "",
        innerText: document.body ? document.body.innerText.slice(0, 200000) : ""
      }))()`,
    );
    // null, not 0, when this process did not do the loading: a click that changes a page in place
    // never produces a document response, and neither does attaching to a tab that is already open.
    // "We do not know" and "the server said nothing" are different answers.
    const status = this.#mainFrameId === null ? null : (this.#statusByFrame.get(this.#mainFrameId) ?? null);
    const analysis = analyzePage({
      html: raw?.html ?? "",
      innerText: raw?.innerText ?? "",
      title: raw?.title ?? "",
      url: raw?.url ?? "",
      status,
      cap: cap ?? TEXT_CAP,
    });
    return { url: raw?.url ?? "", title: raw?.title ?? "", status, ...analysis };
  }

  /** One jpeg of what is on screen, no wider than 1280. Scaled by the browser, so nothing resizes it after. */
  async screenshot(options = {}) {
    return await withDeadline("taking a picture of the page", options.timeoutMs ?? ACTION_TIMEOUT_MS, async () => {
      await this.#ownTab();
      let scale = 1;
      let width = SCREENSHOT_WIDTH;
      try {
        const metrics = await this.#send("Page.getLayoutMetrics", {}, { timeoutMs: 10000 });
        const viewport = metrics?.cssLayoutViewport ?? metrics?.layoutViewport;
        const clientWidth = Number(viewport?.clientWidth ?? 0);
        if (clientWidth > 0) {
          scale = Math.min(1, SCREENSHOT_WIDTH / clientWidth);
          width = Math.round(clientWidth * scale);
        }
      } catch {
        // No metrics means capture at whatever the page is; a picture is better than an error.
      }
      const shot = await this.#send(
        "Page.captureScreenshot",
        { format: "jpeg", quality: options.quality ?? 72, optimizeForSpeed: true },
        { timeoutMs: options.timeoutMs ?? ACTION_TIMEOUT_MS },
      );
      return { base64: shot.data ?? "", mimeType: "image/jpeg", width, scale };
    });
  }

  /** Go to a page and read it back. */
  async open(url, options = {}) {
    const target = String(url ?? "").trim();
    if (target.length === 0) throw new Error("no address was given to open");
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ? target : `https://${target}`;

    return await withDeadline(`opening ${withScheme}`, options.timeoutMs ?? ACTION_TIMEOUT_MS, async () => {
      await this.#ownTab();
      this.#statusByFrame.clear();

      const loaded = this.#connection.waitFor(
        "Page.loadEventFired",
        (_params, sessionId) => sessionId === this.#sessionId,
        options.loadWaitMs ?? 20000,
      );
      const navigation = await this.#send("Page.navigate", { url: withScheme }, { timeoutMs: 20000 });
      if (typeof navigation.errorText === "string" && navigation.errorText.length > 0) {
        throw new Error(`the browser could not open that address: ${plainNavigationError(navigation.errorText)}`);
      }
      if (typeof navigation.frameId === "string") this.#mainFrameId = navigation.frameId;
      await loaded;
      // A short settle so a page that paints its text on load has done it before we read.
      await sleep(options.settleMs ?? 400);

      const page = await this.#readPage(options.cap);
      const shot = options.screenshot === false ? null : await this.screenshot({ timeoutMs: 15000 });
      return { ...page, screenshot: shot, tabId: this.#targetId };
    });
  }

  /** Click something, named by what it says or by a CSS selector. */
  async click(target, options = {}) {
    const wanted = String(target ?? "").trim();
    if (wanted.length === 0) throw new Error("nothing was named to click");

    return await withDeadline(`clicking ${wanted}`, options.timeoutMs ?? ACTION_TIMEOUT_MS, async () => {
      await this.#ownTab();
      const found = await this.#evaluate(`(${LOCATE_FUNCTION})(${JSON.stringify(wanted)}, false)`);
      if (found?.found !== true) throw new Error(notFoundMessage(wanted, found?.nearby));

      await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y, button: "none", clickCount: 0 });
      await this.#send("Input.dispatchMouseEvent", { type: "mousePressed", x: found.x, y: found.y, button: "left", clickCount: 1 });
      await this.#send("Input.dispatchMouseEvent", { type: "mouseReleased", x: found.x, y: found.y, button: "left", clickCount: 1 });
      await sleep(options.settleMs ?? 700);

      const page = await this.#readPage(options.cap);
      const shot = options.screenshot === false ? null : await this.screenshot({ timeoutMs: 15000 });
      return { clicked: found.text || found.label || wanted, ...page, screenshot: shot, tabId: this.#targetId };
    });
  }

  /** Type into a field, optionally pressing Enter after. */
  async type(target, text, options = {}) {
    const wanted = String(target ?? "").trim();
    if (wanted.length === 0) throw new Error("no field was named to type into");
    const value = String(text ?? "");

    return await withDeadline(`typing into ${wanted}`, options.timeoutMs ?? ACTION_TIMEOUT_MS, async () => {
      await this.#ownTab();
      const found = await this.#evaluate(`(${LOCATE_FUNCTION})(${JSON.stringify(wanted)}, true)`);
      if (found?.found !== true) throw new Error(notFoundMessage(wanted, found?.nearby));

      // Click it rather than calling focus(), so the page sees the same events a person makes.
      await this.#send("Input.dispatchMouseEvent", { type: "mousePressed", x: found.x, y: found.y, button: "left", clickCount: 1 });
      await this.#send("Input.dispatchMouseEvent", { type: "mouseReleased", x: found.x, y: found.y, button: "left", clickCount: 1 });
      await this.#evaluate(`(() => { const el = document.activeElement; if (el && typeof el.select === "function") el.select(); })()`);
      await this.#send("Input.insertText", { text: value }, { timeoutMs: 15000 });

      if (options.submit === true) {
        for (const type of ["rawKeyDown", "char", "keyUp"]) {
          await this.#send("Input.dispatchKeyEvent", {
            type,
            key: "Enter",
            code: "Enter",
            text: "\r",
            unmodifiedText: "\r",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        }
        const loaded = this.#connection.waitFor(
          "Page.loadEventFired",
          (_params, sessionId) => sessionId === this.#sessionId,
          options.loadWaitMs ?? 12000,
        );
        await loaded;
      }
      await sleep(options.settleMs ?? 500);

      const page = await this.#readPage(options.cap);
      const shot = options.screenshot === false ? null : await this.screenshot({ timeoutMs: 15000 });
      return { typedInto: found.label || wanted, submitted: options.submit === true, ...page, screenshot: shot, tabId: this.#targetId };
    });
  }

  /** Every tab open in the box's browser, ours marked. */
  async tabs(options = {}) {
    return await withDeadline("listing the tabs", options.timeoutMs ?? ACTION_TIMEOUT_MS, async () => {
      const remembered = readState(this.#port, this.#env);
      const mine = this.#targetId ?? remembered?.targetId ?? null;
      const targets = await this.#pageTargets();
      return targets.map((target) => ({
        id: target.targetId,
        title: target.title ?? "",
        url: target.url ?? "",
        ours: target.targetId === mine,
      }));
    });
  }

  /** Close the tab this driver opened. The browser stays up and the person's own tabs are untouched. */
  async close(options = {}) {
    return await withDeadline("closing the tab", options.timeoutMs ?? ACTION_TIMEOUT_MS, async () => {
      const remembered = readState(this.#port, this.#env);
      const targetId = this.#targetId ?? remembered?.targetId ?? null;
      if (targetId === null) return { closed: false, reason: "there was no tab of ours to close" };
      try {
        await this.#browserSend("Target.closeTarget", { targetId }, { timeoutMs: 10000 });
      } catch {
        // Already gone. Forgetting it below is the whole point either way.
      }
      forgetState(this.#port, this.#env);
      this.#targetId = null;
      this.#sessionId = null;
      return { closed: true, tabId: targetId };
    });
  }
}

function notFoundMessage(wanted, nearby) {
  const base = `nothing on the page matched "${wanted}"`;
  if (!Array.isArray(nearby) || nearby.length === 0) return base;
  return `${base}. What is on the page: ${nearby.slice(0, 8).join(", ")}`;
}

function plainNavigationError(errorText) {
  const map = {
    "net::ERR_NAME_NOT_RESOLVED": "that address does not exist",
    "net::ERR_CONNECTION_REFUSED": "the site refused the connection",
    "net::ERR_CONNECTION_TIMED_OUT": "the site did not answer",
    "net::ERR_INTERNET_DISCONNECTED": "the box has no network right now",
    "net::ERR_CERT_AUTHORITY_INVALID": "the site's certificate did not check out",
    "net::ERR_ABORTED": "the page stopped loading partway",
  };
  return map[errorText] ?? errorText;
}

export { TEXT_CAP };
