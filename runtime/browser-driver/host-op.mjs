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

// CLOUD-BROWSER-1 gave this file a second way in and a second way to be told what to do.
//
// The second way in is `cdpUrl`: a browser somebody else is running, named by its debugger URL,
// instead of a display and a loopback port. Same driver, same page reader, same JPEG, same
// verdicts, same one marked line -- the only difference is which browser is on the other end.
//
// The second way to be TOLD is the one that matters for custody. The request has always arrived
// base64 in argv, which is fine for a display number and an address and is not fine at all for a
// cloud endpoint: that URL carries the session's own credential, and argv is readable from any
// process in the box, the agent's own shell included (MARKET-17/MARKET-24). So a request that
// carries one arrives on stdin (`--request-stdin`) or out of a file the host wrote 0600 in a 0700
// directory (`--request-file <path>`), and the file is unlinked in a finally whatever happened.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
  // A cloud endpoint replaces the display and the port outright: there is no Chrome to start here,
  // no window index to work out, and no seat on the box's screen to keep the browser inside.
  const cdpUrl = typeof request.cdpUrl === "string" && request.cdpUrl.length > 0 ? request.cdpUrl : null;

  const wantsShot = typeof request.screenshotPath === "string" && request.screenshotPath.length > 0;
  const actionOptions = wantsShot ? {} : { screenshot: false };

  const driver = cdpUrl === null
    ? await BrowserDriver.attach(attachOptions)
    : await BrowserDriver.attachCdpUrl(cdpUrl, {});
  try {
    let page;
    switch (request.op) {
      case "open":
        // allowHosts is the operator's list of internal names the browser may still open. It is
        // read from the request and never from the model's arguments: the host writes it after
        // the arguments are spread, so an "allowHosts" the model made up is overwritten.
        page = await driver.open(request.url, {
          ...actionOptions,
          allowHosts: Array.isArray(request.allowHosts) ? request.allowHosts : [],
        });
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
    // CLOUD-BROWSER-1. The page loaded and said nothing. The host reads this to decide whether a
    // second engine is worth one try; the model reads the sentence the host makes out of it, so it
    // is never handed a footer and left to summarise it as the page.
    if (page.emptyShell === true) {
      result.emptyShell = true;
      if (typeof page.emptyShellReason === "string" && page.emptyShellReason.length > 0) {
        result.emptyShellReason = page.emptyShellReason;
      }
    }
    // Which browser answered, so nothing downstream has to infer it. The gate's desktop leg reads
    // this so it cannot pass vacuously, and the ledger reads it so a row names a real engine.
    result.engine = cdpUrl === null ? "box" : "cloud";
    // The page was still loading when we read it. Better than nothing, and the model has to know
    // it is looking at a page mid-flight rather than at all of it.
    if (page.stillLoading === true) result.stillLoading = true;
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

// A hard budget for the WHOLE call, attaching included.
//
// The driver's own deadline is 30 seconds per action, but attaching is not an action: on an agent's
// first page the browser may still be starting, and that is outside it. The shell that runs this
// has a budget of its own, and when it runs out it kills the process -- which is the one failure
// nobody can be told anything about. Measured on grok-bot-local-vm 2026-09-07, that is exactly what
// a person saw: "Browser driver shell failed (failure)", no cause, no page.
//
// So: finish first, in plain words, with time to spare. 55 seconds covers a cold Chrome (about 45)
// plus an action, and still answers well inside any shell budget.
const BUDGET_MS = Number.parseInt(process.env.TITANBOT_BROWSER_BUDGET_MS ?? "55000", 10);
const watchdog = setTimeout(() => {
  emit({ ok: false, error: "the browser is taking too long to answer. It may still be starting up on this computer; ask me again in a moment." });
  process.exit(0);
}, BUDGET_MS);
watchdog.unref?.();

/** Everything on stdin, as a string. Used only when the caller said `--request-stdin`. */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", (error) => reject(error));
  });
}

/**
 * The three ways this process is told what to do, and the one rule that decides which:
 *
 *   --request-stdin        the JSON arrives on stdin. Nothing is in argv and nothing is on disk.
 *   --request-file <path>  the JSON is in a file the host wrote 0600. Read once, unlinked in a
 *                          finally whatever happened, including on a throw.
 *   <base64>               the way it has always worked, and still the way every box-browser call
 *                          works: a display number and an address, neither of them a secret.
 *
 * The file leg exists because the box's exec path cannot pipe stdin to a command (buildHostShellArgs
 * carries a command string and nothing else), and a cloud endpoint must not reach argv. What is
 * left is a residual this file states rather than papers over: the agent's shell runs as root in
 * the same container, so between the write and the unlink a determined agent could read the file.
 * That window is one tool call long, the endpoint dies with the session minutes later, and the
 * thing it fixes -- a credential sitting in a root process's argument list for anything running
 * `ps` to read -- was permanent.
 */
async function readRequest() {
  const argv = process.argv;
  if (argv.includes("--request-stdin")) return JSON.parse(await readStdin());
  const at = argv.indexOf("--request-file");
  if (at >= 0) {
    const file = argv[at + 1] ?? "";
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } finally {
      try { rmSync(file, { force: true }); } catch { /* already gone, or never ours to remove */ }
    }
  }
  return JSON.parse(Buffer.from(argv[2] ?? "", "base64").toString("utf8"));
}

let result;
try {
  result = await run(await readRequest());
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
clearTimeout(watchdog);
emit(result);
process.exit(0);
