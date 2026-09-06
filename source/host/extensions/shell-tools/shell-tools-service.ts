import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { ShellToolEntry } from "./shell-tool-catalog.js";
import { readShellEnvSecrets } from "./shell-secrets.js";

/** The contract's cap. An installer that has not finished in five minutes is not going to. */
export const SHELL_TOOL_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** What comes back to the console: the tail, not the transcript. */
export const SHELL_TOOL_INSTALL_OUTPUT_LINES = 40;
const SHELL_TOOL_INSTALL_OUTPUT_LIMIT = 256 * 1024;

export interface ShellToolInstallResult {
  readonly id: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly command: string;
  readonly output: string;
}

export function tailLines(text: string, limit = SHELL_TOOL_INSTALL_OUTPUT_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.length <= limit ? lines.join("\n") : lines.slice(lines.length - limit).join("\n");
}

/**
 * A stored value must not come back out of this module in installer output. Nothing in the two
 * catalog installers prints its environment, but an installer is a script off the internet and the
 * output goes to a page and to a gate log, so the values are struck before either sees them.
 */
export function redactShellSecretValues(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of values) {
    if (value.length < 4) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

export interface RunShellToolInstallOptions {
  /** The sand data root, so the installer inherits the stored credentials. Omit for none. */
  readonly rootDir?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/**
 * Runs the catalog's install command in the box, as whoever the host runs as -- user `box`, the
 * same identity that spawns every stdio connector. It deliberately does NOT go through the box
 * exec-daemon: that daemon is a separate process with a different home, and both of these
 * installers put their binary under the running user's `~` (`~/.local/bin`), so which user runs
 * them is the difference between installing the tool and installing it for nobody.
 *
 * The stored shell credentials ride in the installer's environment because CodeRabbit's installer
 * reads `CODERABBIT_API_KEY` to skip its browser prompt. `CI=1` in the command already does that;
 * this makes the second half true as well.
 */
export async function runShellToolInstall(
  entry: ShellToolEntry,
  options: RunShellToolInstallOptions = {},
): Promise<ShellToolInstallResult> {
  const secrets = options.rootDir == null ? {} : readShellEnvSecrets(options.rootDir);
  const child = spawn("/bin/sh", ["-lc", entry.install], {
    cwd: options.cwd ?? homedir(),
    env: { ...process.env, ...secrets },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: unknown): void => {
    if (output.length >= SHELL_TOOL_INSTALL_OUTPUT_LIMIT) return;
    output += String(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform !== "win32" && child.pid != null) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, options.timeoutMs ?? SHELL_TOOL_INSTALL_TIMEOUT_MS);
  const closed = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    // A spawn that never started has no exit code and no signal; the reason belongs in the output,
    // which is the field the console shows, rather than in a signal field that would be a lie.
    child.once("error", (error) => { collect(`the installer did not start: ${error.message}\n`); resolve({ code: null, signal: null }); });
    child.once("close", (code, signal) => resolve({ code, signal: signal ?? null }));
  });
  clearTimeout(timer);
  const values = Object.values(secrets);
  return {
    id: entry.id,
    ok: closed.code === 0 && !timedOut,
    exitCode: closed.code,
    signal: closed.signal,
    timedOut,
    command: entry.install,
    output: tailLines(redactShellSecretValues(output, values)) || (timedOut
      ? `no output; killed after ${(options.timeoutMs ?? SHELL_TOOL_INSTALL_TIMEOUT_MS) / 1000}s`
      : "no output"),
  };
}

/** A probe must not outlive the question it answers; `command -v` is a builtin and returns at once. */
export const SHELL_TOOL_PROBE_TIMEOUT_MS = 15_000;
/** The catalog's binaries are literals in this repo; the guard keeps a future entry off the shell. */
const SAFE_BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Is this tool's program actually on the box's PATH?
 *
 * The host runs INSIDE the box and already spawns `/bin/sh -lc` there to install these tools, so
 * the same shell can be asked whether the install took -- and it is the only true answer. A stored
 * key is a different fact: a key with no program means the agent reports a CLI it cannot run, and a
 * program with no key means the operator is told to install what is already installed.
 *
 * `-lc` from the running user's home, exactly as `runShellToolInstall` spawns, because that is what
 * puts `~/.local/bin` -- where both catalog installers land their binary -- on PATH. Only the exit
 * status is read: `command -v` prints a path, and this module returns a boolean.
 */
export async function probeShellToolBinary(
  entry: ShellToolEntry,
  options: { readonly timeoutMs?: number } = {},
): Promise<boolean> {
  if (!SAFE_BINARY.test(entry.binary)) return false;
  const child = spawn("/bin/sh", ["-lc", `command -v ${entry.binary}`], {
    cwd: homedir(),
    stdio: ["ignore", "ignore", "ignore"],
  });
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
    options.timeoutMs ?? SHELL_TOOL_PROBE_TIMEOUT_MS);
  try {
    return await new Promise<boolean>((resolve) => {
      // A shell that could not be spawned at all is "not installed", not a rejection: this answers
      // a question asked in the middle of describing a plugin, and it must not unwind that.
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The command the box shell answers "is this credential in my environment" with. It prints a
 * marker, never the value, and `${VAR:+}` is the test: an empty value is unset, which is what a
 * deleted credential looks like on this box until the next restart (see shell-secrets.ts).
 */
export function shellSecretProbeCommand(field: string): string {
  return `if [ -n "\${${field}:-}" ]; then echo shell-secret:set; else echo shell-secret:unset; fi`;
}

export function readShellSecretProbe(stdout: string): "set" | "unset" | "unknown" {
  if (/shell-secret:set/.test(stdout)) return "set";
  if (/shell-secret:unset/.test(stdout)) return "unset";
  return "unknown";
}

/**
 * The tool's own published SKILL.md, fetched by the host rather than by the console: the console
 * is a browser and raw.githubusercontent.com does not answer it cross-origin.
 */
export async function fetchShellToolSkill(
  entry: ShellToolEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (entry.skillUrl == null) throw new Error(`${entry.name} publishes no skill to import`);
  const response = await fetchImpl(entry.skillUrl);
  if (!response.ok) throw new Error(`${entry.skillUrl} answered ${response.status}`);
  const markdown = await response.text();
  if (markdown.trim().length === 0) throw new Error(`${entry.skillUrl} answered an empty document`);
  return markdown;
}
