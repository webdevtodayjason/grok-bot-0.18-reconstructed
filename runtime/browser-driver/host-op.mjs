// The seam between Titan's four browser tools and the driver next door.
//
// The host does not talk to Chrome. It runs one shell command inside the box and reads one line of
// JSON back, and it has done that since the browser subagent existed. This file is the box end of
// that call for the four tools the main agent holds: it takes the same base64 request the older
// driver takes, drives BrowserDriver, and prints the same marked result line the host already
// knows how to parse. Nothing about the fifteen subagent tools goes through here.
//
// It lives in the runtime mount rather than being uploaded per host process because the driver it
// calls does. deploy/r750/sync.sh ships the whole directory, install.sh refuses a tree without it,
// and every box already bind-mounts /opt/titanbot-runtime read-only, so there is nothing new to
// mount and nothing to install.
//
// One line of output, always, whatever happened. A tool that prints nothing is the one failure the
// host cannot describe to a person.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserDriver } from "./driver.mjs";

const RESULT_MARKER = "__SAND_BROWSER_RESULT__";

/** Everything the host is told, in the shape sand-browser-tools.ts parses. */
function emit(result) {
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

/**
 * The picture, written where the host asked for it so it can be pulled back off the box. The
 * driver hands back JPEG bytes at most 1280 wide; the host's path still ends in .png because that
 * is what it has always named the file, so the real type travels in the JSON beside it rather than
 * being guessed from the name.
 */
function writeShot(shot, screenshotPath) {
  if (shot === null || shot === undefined) return null;
  if (typeof shot.base64 !== "string" || shot.base64.length === 0) return null;
  if (typeof screenshotPath !== "string" || screenshotPath.length === 0) return null;
  try {
    mkdirSync(path.dirname(screenshotPath), { recursive: true });
    writeFileSync(screenshotPath, Buffer.from(shot.base64, "base64"));
    return { mimeType: shot.mimeType ?? "image/jpeg", width: shot.width };
  } catch {
    // A picture we could not save is not worth failing the read over: the words are the answer.
    return null;
  }
}

/** What the model reads first. One sentence about what happened, in plain words. */
function summarize(op, page) {
  if (op === "open") return `Opened the page.`;
  if (op === "click") return `Clicked ${page?.clicked ?? "it"}.`;
  if (op === "type") {
    const where = page?.typedInto ?? "the field";
    return page?.submitted === true ? `Typed into ${where} and pressed Enter.` : `Typed into ${where}.`;
  }
  return "Took a picture of the page.";
}

async function run(request) {
  const attachOptions = {};
  if (typeof request.cdpPort === "number") attachOptions.port = request.cdpPort;
  if (typeof request.display === "number") attachOptions.display = request.display;

  const wantsShot = typeof request.screenshotPath === "string" && request.screenshotPath.length > 0;
  const actionOptions = wantsShot ? {} : { screenshot: false };

  const driver = await BrowserDriver.attach(attachOptions);
  try {
    let page;
    switch (request.op) {
      case "open":
        page = await driver.open(request.url, actionOptions);
        break;
      case "click":
        page = await driver.click(request.target, actionOptions);
        break;
      case "type":
        page = await driver.type(request.target, request.text ?? "", { ...actionOptions, submit: request.submit === true });
        break;
      case "screenshot": {
        const shot = await driver.screenshot({});
        page = { screenshot: shot };
        break;
      }
      default:
        throw new Error(`there is no "${String(request.op)}" browser action`);
    }

    const saved = writeShot(page.screenshot, request.screenshotPath);
    const result = { ok: true, summary: summarize(request.op, page) };
    if (typeof page.url === "string" && page.url.length > 0) result.url = page.url;
    if (typeof page.title === "string") result.title = page.title;
    if (typeof page.text === "string" && page.text.length > 0) result.text = page.text;
    if (page.needsLogin === true) result.needsLogin = true;
    if (page.blocked === true) result.blocked = true;
    if (saved !== null) {
      result.screenshot = true;
      result.mimeType = saved.mimeType;
    }
    // The tab this driver owns, so the host's own view bookkeeping has something stable to key on.
    if (typeof page.tabId === "string") result.viewId = page.tabId;
    return result;
  } finally {
    driver.detach();
  }
}

// The host's own watchdog is 30 seconds per action and the driver's is the same, so this one only
// catches a hang below both of them. It still has to print a line.
const watchdog = setTimeout(() => {
  emit({ ok: false, error: "the browser did not answer in time and the action was given up on" });
  process.exit(0);
}, 100_000);
watchdog.unref?.();

let result;
try {
  const raw = process.argv[2] ?? "";
  result = await run(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
clearTimeout(watchdog);
emit(result);
process.exit(0);
