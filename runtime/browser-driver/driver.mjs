// The browser Titan drives: open a page, read it, click a thing, type a thing, take one picture.
//
// It attaches to the browser the box already runs on the person's profile and the person's display,
// in a tab of its own. That matters twice over: the logins are there, and the desktop view keeps
// showing the same window, so a person watching can see what happened and take over. It never opens
// a second window and never closes the browser.
//
// Every action has a deadline of 30 seconds and fails in plain words.

import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { CdpConnection } from "./cdp.mjs";
import { ensureBrowser } from "./chrome.mjs";
import { analyzePage, TEXT_CAP } from "./page-text.mjs";

export const ACTION_TIMEOUT_MS = 30000;
export const SCREENSHOT_WIDTH = 1280;
// How much of an action's budget is kept back for reading the page and photographing it, so a page
// that never finishes loading still comes back with something in it.
export const LOAD_RESERVE_MS = 14000;

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

// ---------------------------------------------------------------- where the browser may go
//
// An address comes from the model, and the model is told things by pages it read, by peers and by
// pasted text. Without this check "open file:///etc/passwd" reads the box's own files and "open
// http://127.0.0.1:9232" reads the services sitting beside it, and both come back to the provider
// as page text plus a picture. Measured on grok-bot-local-vm 2026-09-07: both worked.
//
// So: the public web only. http and https, and an address that does not land on this machine, this
// network, or the computer the box runs on. Names are resolved before we go, because a name is
// free to point at 127.0.0.1. An operator who wants an internal site read names it in the host
// setting SAND_BROWSER_ALLOW_HOSTS, which travels in the request beside the address and never
// comes from the model's own arguments.
export const NOT_PUBLIC_WEB = "I can only open pages on the public web.";

const PRIVATE_HOST_NAMES = new Set([
  "localhost", "ip6-localhost", "ip6-loopback", "host.docker.internal", "gateway.docker.internal",
]);

function isPrivateIpv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = numbers;
  if (a === 0 || a === 10 || a === 127) return true;                 // this host, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true;                  // private
  if (a === 192 && b === 168) return true;                           // private
  if (a === 192 && b === 0) return true;                             // protocol assignments
  if (a === 169 && b === 254) return true;                           // link local, and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;                 // carrier grade nat, where a tailnet lives
  if (a >= 224) return true;                                         // multicast and reserved
  return false;
}

function isPrivateIpv6(address) {
  const plain = address.toLowerCase().split("%")[0];
  if (plain === "::" || plain === "::1") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
  if (mapped !== null) return isPrivateIpv4(mapped[1]);
  return /^(fe8|fe9|fea|feb|fc|fd)/.test(plain);
}

/** True when this literal address belongs to the box, its network, or the machine underneath it. */
export function isPrivateAddress(address) {
  const plain = String(address ?? "").trim();
  if (plain.length === 0) return true;
  return plain.includes(":") ? isPrivateIpv6(plain) : isPrivateIpv4(plain);
}

/**
 * The address we are willing to open, or a refusal in plain words. Returns the address with a
 * scheme on it, so callers do not have to guess one twice.
 */
export async function checkPublicWebUrl(url, options = {}) {
  const target = String(url ?? "").trim();
  if (target.length === 0) throw new Error("no address was given to open");
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ? target : `https://${target}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`${NOT_PUBLIC_WEB} That is not a web address.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(NOT_PUBLIC_WEB);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.length === 0) throw new Error(NOT_PUBLIC_WEB);

  const allowed = new Set(
    (options.allowHosts ?? []).map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry.length > 0),
  );
  if (allowed.has(host)) return withScheme;

  if (PRIVATE_HOST_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error(NOT_PUBLIC_WEB);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw new Error(NOT_PUBLIC_WEB);
    return withScheme;
  }
  let addresses;
  try {
    addresses = await (options.resolve ?? lookup)(host, { all: true });
  } catch {
    // A name that will not resolve is the browser's to report, in its own words, a moment from now.
    return withScheme;
  }
  const found = Array.isArray(addresses) ? addresses : [addresses];
  if (found.some((entry) => isPrivateAddress(entry?.address ?? entry))) throw new Error(NOT_PUBLIC_WEB);
  return withScheme;
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
  /**
   * CLOUD-BROWSER-1. A cloud session is a fresh browser that lives for one tool call, so there is
   * no tab to remember between calls and nowhere sensible to remember it: the note on disk is keyed
   * by loopback port, and every cloud session would share the one file and hand the next session a
   * target id belonging to a browser that no longer exists. Stateless means: never read the note,
   * never write it, and reuse whatever page the vendor already opened rather than making a second.
   */
  #stateless = false;

  constructor({ connection, port, env, stateless }) {
    this.#connection = connection;
    this.#port = port;
    this.#env = env ?? process.env;
    this.#stateless = stateless === true;
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

  /**
   * CLOUD-BROWSER-1. Attach to a browser somebody else is running, named by its debugger URL.
   *
   * This is the WHOLE cloud leg of the driver. There is no second page reader, no second screenshot
   * pipeline and no second set of verdicts: open, click, type and screenshot below are reached
   * exactly as they are for the box's own Chrome, so the result of a cloud read is identical to the
   * result of a box read by construction rather than because two implementations were kept in step.
   * `checkPublicWebUrl` in `open` runs on this path too, which is the point of putting the cloud
   * branch HERE rather than in a host-side re-implementation: that guard resolves the name and
   * refuses a public host that lands on a private address, and a re-implementation would have
   * quietly dropped it.
   */
  static async attachCdpUrl(cdpUrl, options = {}) {
    const env = options.env ?? process.env;
    const connection = await CdpConnection.attachTo(cdpUrl, { timeoutMs: options.timeoutMs ?? 20000 });
    const driver = new BrowserDriver({ connection, port: null, env, stateless: true });
    driver.startedBrowser = false;
    driver.cloud = true;
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
    if (!this.#stateless) writeState(this.#port, { targetId: created.targetId, at: new Date().toISOString() }, this.#env);
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
    // CLOUD-BROWSER-1. A cloud session opens with exactly one page already there. Taking THAT page
    // rather than adding one keeps the vendor's own live view -- which shows the session's first
    // page -- pointed at the page the person is being asked to look at. On the box path nothing
    // changes: the note on disk is still what decides, so the agent's tab is still its own tab.
    const remembered = this.#stateless ? null : readState(this.#port, this.#env);
    const reuse = this.#stateless
      ? (targets[0]?.targetId ?? null)
      : remembered !== null && targets.some((target) => target.targetId === remembered.targetId)
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
      if (!this.#stateless) forgetState(this.#port, this.#env);
      // And close it. Forgetting a wedged tab without closing it leaves it open in the browser the
      // person is watching, still loading, and the next call opens another beside it: measured on
      // grok-bot-local-vm 2026-09-07, the tab count climbed one per failed open and never came down.
      try {
        await this.#browserSend("Target.closeTarget", { targetId: reuse }, { timeoutMs: 5000 });
      } catch {
        // Already gone, or the browser will not talk about it. Either way we are making a new one.
      }
      const made = await this.#newTab();
      await this.#attach(made);
      return made;
    }
  }

  async #evaluate(expression, options = {}) {
    // timeoutMs is ours, not the page's: leaving it in the params sends Runtime.evaluate a field
    // it does not have.
    const { timeoutMs, ...params } = options;
    const result = await this.#send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, ...params },
      { timeoutMs: timeoutMs ?? 20000 },
    );
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? "the page rejected it";
      throw new Error(`the page could not do that: ${String(detail).split("\n")[0]}`);
    }
    return result.result?.value;
  }

  async #readPage(cap, options = {}) {
    const raw = await this.#evaluate(
      `(() => ({
        url: location.href,
        title: document.title || "",
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, 3000000) : "",
        innerText: document.body ? document.body.innerText.slice(0, 200000) : ""
      }))()`,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
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
    const withScheme = await checkPublicWebUrl(url, { allowHosts: options.allowHosts ?? [] });
    const budget = options.timeoutMs ?? ACTION_TIMEOUT_MS;

    return await withDeadline(`opening ${withScheme}`, budget, async () => {
      await this.#ownTab();
      this.#statusByFrame.clear();
      const endsAt = Date.now() + budget;
      const left = (most) => Math.max(1500, Math.min(most, endsAt - Date.now() - 500));

      // The load wait is capped so the read and the picture still fit inside the action's budget.
      // A page whose load event never fires is exactly the page a fetch could not get, so it must
      // come back with its words and its picture rather than with nothing at all.
      const loadWaitMs = Math.max(2000, Math.min(options.loadWaitMs ?? 20000, budget - LOAD_RESERVE_MS));
      const loaded = this.#connection.waitFor(
        "Page.loadEventFired",
        (_params, sessionId) => sessionId === this.#sessionId,
        loadWaitMs,
      );
      const navigation = await this.#send("Page.navigate", { url: withScheme }, { timeoutMs: 20000 });
      // A refusal with no body to render arrives here rather than as a page, so it is read as a
      // refusal instead of thrown away: a bare 403 never reached the block detector before.
      let refused = false;
      if (typeof navigation.errorText === "string" && navigation.errorText.length > 0) {
        if (isRefusalNavigationError(navigation.errorText)) refused = true;
        else throw new Error(`the browser could not open that address: ${plainNavigationError(navigation.errorText)}`);
      }
      if (typeof navigation.frameId === "string") this.#mainFrameId = navigation.frameId;
      const stillLoading = (await loaded) === undefined;
      // A short settle so a page that paints its text on load has done it before we read.
      if (!stillLoading) await sleep(options.settleMs ?? 400);

      const page = await this.#readPage(options.cap, { timeoutMs: left(8000) });
      const shot = options.screenshot === false ? null : await this.screenshot({ timeoutMs: left(15000) });
      // When the site refuses, the tab lands on Chrome's own error page and location.href reads
      // chrome-error://chromewebdata/. That is no use to anyone: the audit ledger's whole job is
      // to say what was looked at, so it says the address that was asked for.
      const landedOn = typeof page.url === "string" && page.url.startsWith("chrome-error://")
        ? withScheme
        : page.url;
      return {
        ...page,
        url: landedOn,
        ...(refused ? { blocked: true } : {}),
        ...(stillLoading ? { stillLoading: true } : {}),
        screenshot: shot,
        tabId: this.#targetId,
      };
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

/**
 * The site said no rather than the network failing: an error status with nothing to render, or a
 * block Chrome applied itself. Those are pages the block detector should get a look at, not
 * failures, so the model can say "the site would not show me this" and move on.
 */
function isRefusalNavigationError(errorText) {
  const code = String(errorText ?? "");
  return code === "net::ERR_HTTP_RESPONSE_CODE_FAILURE" || code.startsWith("net::ERR_BLOCKED_BY");
}

function plainNavigationError(errorText) {
  const map = {
    "net::ERR_NAME_NOT_RESOLVED": "that address does not exist",
    "net::ERR_CONNECTION_REFUSED": "the site refused the connection",
    "net::ERR_CONNECTION_TIMED_OUT": "the site did not answer",
    "net::ERR_TIMED_OUT": "the site did not answer",
    "net::ERR_ADDRESS_UNREACHABLE": "the site could not be reached",
    "net::ERR_INTERNET_DISCONNECTED": "the box has no network right now",
    "net::ERR_EMPTY_RESPONSE": "the site answered with nothing",
    "net::ERR_TOO_MANY_REDIRECTS": "the site kept sending us somewhere else and never landed",
    "net::ERR_SSL_PROTOCOL_ERROR": "the secure connection to the site failed",
    "net::ERR_ABORTED": "the page stopped loading partway",
  };
  const known = map[errorText];
  if (known !== undefined) return known;
  if (/^net::ERR_CERT/.test(String(errorText))) return "the site's certificate did not check out";
  // Whatever else it was, it is not going in front of a person as a net:: code.
  return "the site did not load";
}

export { TEXT_CAP };
