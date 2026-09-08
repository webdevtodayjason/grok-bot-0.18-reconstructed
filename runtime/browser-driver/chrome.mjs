// Finding the box's Chrome, and starting it the way the box starts it.
//
// The box image's /usr/local/bin/box-chrome owns the launch: it picks the profile directory from
// the display number, sets the XDG runtime dir, and passes --remote-debugging-port with
// --remote-debugging-address=127.0.0.1. This driver never launches a browser itself, because the
// one time something did, the operator watched one browser on the desktop while the agent drove
// another one with a different profile and no logins. So: find the running one, and if there is
// none, ask box-chrome for it and wait.

import { spawn } from "node:child_process";
import { cdpAlive } from "./cdp.mjs";

export const DEFAULT_PORT_BASE = 9222;

/** The display number this process is pointed at, or 1 when nothing says. */
export function displayNumber(env = process.env) {
  const display = env.SAND_BOX_DISPLAY ?? env.DISPLAY ?? "";
  const match = /^:(\d+)/.exec(String(display).trim());
  return match === null ? 1 : Number(match[1]);
}

/**
 * The debugging port for a display, matching box-chrome's own arithmetic: 9222 + display, except
 * display 1 which the launcher pins to 9223.
 */
export function portForDisplay(display, env = process.env) {
  const override = env.SAND_CHROME_REMOTE_DEBUG_PORT;
  if (override !== undefined && String(override).trim() !== "") {
    const port = Number(String(override).trim());
    if (Number.isInteger(port) && port > 0) return port;
  }
  const base = Number(env.SAND_BOX_CDP_PORT_BASE ?? DEFAULT_PORT_BASE);
  return (Number.isInteger(base) ? base : DEFAULT_PORT_BASE) + Number(display);
}

/** Ports worth trying, best guess first: the one this display should use, then the neighbours. */
export function candidatePorts(display, env = process.env) {
  const first = portForDisplay(display, env);
  const base = Number(env.SAND_BOX_CDP_PORT_BASE ?? DEFAULT_PORT_BASE);
  const ordered = [first];
  for (let offset = 1; offset <= 10; offset += 1) {
    const port = (Number.isInteger(base) ? base : DEFAULT_PORT_BASE) + offset;
    if (!ordered.includes(port)) ordered.push(port);
  }
  return ordered;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The port a browser is actually answering on. Tries the display's own port first so a box with ten
 * seats drives the one the person is looking at, and only then goes looking.
 */
export async function findLivePort(options = {}) {
  const env = options.env ?? process.env;
  if (options.port !== undefined) {
    const alive = await cdpAlive(options.port);
    return alive ? options.port : null;
  }
  const display = options.display ?? displayNumber(env);
  for (const port of candidatePorts(display, env)) {
    if (await cdpAlive(port)) return port;
  }
  return null;
}

/**
 * Give back a port with a browser on it, starting the box's browser if there is not one. Never
 * launches chrome directly: box-chrome is the only launcher that gets the profile and the display
 * right, and a second browser on a different profile is the failure this avoids.
 */
export async function ensureBrowser(options = {}) {
  const env = options.env ?? process.env;
  const display = options.display ?? displayNumber(env);
  const existing = await findLivePort({ ...options, env, display });
  if (existing !== null) return { port: existing, started: false };

  const wanted = options.port ?? portForDisplay(display, env);
  await new Promise((resolve) => {
    const child = spawn(options.launcher ?? "box-chrome", ["--new-window"], {
      env: { ...env, DISPLAY: `:${display}` },
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => resolve(undefined));
    child.on("exit", () => resolve(undefined));
    child.unref?.();
    setTimeout(() => resolve(undefined), options.launchWaitMs ?? 45000);
  });

  const deadline = Date.now() + (options.readyWaitMs ?? 30000);
  while (Date.now() < deadline) {
    if (await cdpAlive(wanted)) return { port: wanted, started: true };
    await sleep(500);
  }
  throw new Error(`the box browser did not come up with a debugging port on ${wanted}`);
}
