#!/usr/bin/env node
// The command line onto the driver, so a gate on the Mac and a tool in the box call the same code.
//
//   node runtime/browser-driver/cli.mjs open https://example.com
//   node runtime/browser-driver/cli.mjs click "Sign in"
//   node runtime/browser-driver/cli.mjs type "#search" "titanium computing" --submit
//   node runtime/browser-driver/cli.mjs screenshot --out /tmp/shot.jpg
//   node runtime/browser-driver/cli.mjs tabs
//   node runtime/browser-driver/cli.mjs close
//
// One line of JSON on stdout, always, so the caller never has to parse prose. The picture is
// written to a file and the JSON carries its path and size, because a 200 KB base64 string in a
// pipe is how the last driver made its logs unreadable. --inline-image puts it in the JSON anyway
// when the caller wants it there.
//
// Exit codes: 0 done, 1 the browser said no, 2 the arguments were wrong.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserDriver } from "./driver.mjs";
import { TEXT_CAP } from "./page-text.mjs";

const USAGE = `usage:
  cli.mjs open <url> [--out <file.jpg>] [--chars N] [--no-screenshot] [--inline-image]
  cli.mjs click <text-or-selector> [--out <file.jpg>]
  cli.mjs type <text-or-selector> <text> [--submit] [--out <file.jpg>]
  cli.mjs screenshot [--out <file.jpg>] [--inline-image]
  cli.mjs tabs
  cli.mjs close

  common: [--port N] [--display N] [--timeout SECONDS] [--pretty]`;

function parseArguments(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    if (["submit", "pretty", "inline-image", "no-screenshot"].includes(name)) {
      flags[name] = true;
      continue;
    }
    i += 1;
    flags[name] = argv[i];
  }
  return { positional, flags };
}

function defaultShotPath(flags) {
  if (typeof flags.out === "string" && flags.out.length > 0) return flags.out;
  const directory = process.env.TITANBOT_BROWSER_STATE_DIR ?? "/tmp/.titanbot-browser";
  return path.join(directory, `shot-${Date.now()}.jpg`);
}

function saveShot(shot, flags) {
  if (shot === null || shot === undefined || typeof shot.base64 !== "string" || shot.base64.length === 0) return null;
  const bytes = Buffer.from(shot.base64, "base64");
  const file = defaultShotPath(flags);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const record = { path: file, bytes: bytes.length, mimeType: shot.mimeType, width: shot.width };
  if (flags["inline-image"] === true) record.base64 = shot.base64;
  return record;
}

async function main(argv) {
  const { positional, flags } = parseArguments(argv);
  const command = positional[0];
  if (command === undefined || command === "help" || flags.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 2;
  }

  const attachOptions = {};
  if (flags.port !== undefined) attachOptions.port = Number(flags.port);
  if (flags.display !== undefined) attachOptions.display = Number(flags.display);
  const actionOptions = {};
  if (flags.timeout !== undefined) actionOptions.timeoutMs = Math.round(Number(flags.timeout) * 1000);
  if (flags.chars !== undefined) actionOptions.cap = Math.min(TEXT_CAP, Math.max(200, Number(flags.chars)));
  if (flags["no-screenshot"] === true) actionOptions.screenshot = false;

  const driver = await BrowserDriver.attach(attachOptions);
  try {
    let result;
    switch (command) {
      case "open": {
        if (positional[1] === undefined) throw Object.assign(new Error("open needs an address"), { usage: true });
        const page = await driver.open(positional[1], actionOptions);
        result = { ...page, screenshot: saveShot(page.screenshot, flags) };
        break;
      }
      case "click": {
        if (positional[1] === undefined) throw Object.assign(new Error("click needs something to click"), { usage: true });
        const page = await driver.click(positional[1], actionOptions);
        result = { ...page, screenshot: saveShot(page.screenshot, flags) };
        break;
      }
      case "type": {
        if (positional[1] === undefined || positional[2] === undefined) {
          throw Object.assign(new Error("type needs a field and the text to put in it"), { usage: true });
        }
        const page = await driver.type(positional[1], positional[2], { ...actionOptions, submit: flags.submit === true });
        result = { ...page, screenshot: saveShot(page.screenshot, flags) };
        break;
      }
      case "screenshot": {
        const shot = await driver.screenshot(actionOptions);
        result = { screenshot: saveShot(shot, flags) };
        break;
      }
      case "tabs":
        result = { tabs: await driver.tabs(actionOptions) };
        break;
      case "close":
        result = await driver.close(actionOptions);
        break;
      default:
        throw Object.assign(new Error(`there is no "${command}" command`), { usage: true });
    }
    const payload = { ok: true, command, port: driver.port, browser: driver.browserVersion, startedBrowser: driver.startedBrowser === true, ...result };
    process.stdout.write(`${JSON.stringify(payload, null, flags.pretty === true ? 2 : 0)}\n`);
    return 0;
  } finally {
    driver.detach();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const usage = error?.usage === true;
  process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
  if (usage) process.stderr.write(`${USAGE}\n`);
  process.exitCode = usage ? 2 : 1;
}
