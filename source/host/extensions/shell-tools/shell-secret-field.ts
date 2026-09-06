/**
 * SECRET-1. The name rule for a value that lands in the AGENT'S OWN BOX SHELL.
 *
 * The connector store's `isConnectorEnvFieldName` guards a different destination: the environment
 * of an MCP server this host spawns. This store's destination is the exec-daemon that spawns every
 * `/bin/sh -lc` the agent runs, so the reserved set is larger and the shape is stricter:
 *
 *  - UPPERCASE only. A shell env name is uppercase by convention, and the field name is chosen by
 *    the MODEL from a card a human reads in a hurry: `path` next to `PATH` is a name a reviewer
 *    skims past, and the pair would be two different variables. One shape, no near-misses.
 *  - Process control stays refused, for the reason connector-secrets.ts already gives: a request
 *    captioned "paste your API token" must not be able to put the pasted string into NODE_OPTIONS
 *    or LD_PRELOAD. Here it would be the agent's own shell, which is worse, not better.
 *  - The shell's own identity -- HOME, PWD, USER, LOGNAME, SHELL, TERM -- is refused because the
 *    box control plane MERGES this update into the daemon's environment. Rewriting HOME would move
 *    every tool's config directory out from under it; that is a broken box, not a credential.
 *  - SAND_* is refused because those are the host's and the box's own switches (SAND_TOOL_TRACE,
 *    SAND_PROFILE_DIRS, SAND_DESKTOP_SUPERVISION_DISABLED and the rest). A secret card is not a
 *    route for the model to reconfigure its own runtime.
 *
 * Nothing here touches the filesystem, so the send-message schema can import it and refuse a bad
 * field at the tool boundary -- before the human is ever shown a card that cannot be honoured.
 */

/** Uppercase POSIX environment variable name. */
const SHELL_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Process control: code execution wearing a credential's clothes. */
const PROCESS_CONTROL_NAMES = new Set([
  "PATH", "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "PYTHONPATH", "PYTHONSTARTUP",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "BASH_ENV", "ENV", "IFS", "SHELL",
]);
const PROCESS_CONTROL_PREFIXES = ["LD_", "DYLD_"];

/** The shell's own identity. Overwriting any of these breaks the box rather than crediting it. */
const SHELL_IDENTITY_NAMES = new Set(["HOME", "PWD", "OLDPWD", "USER", "LOGNAME", "TERM", "TMPDIR"]);

/** The host's and the box's own switches. */
const RESERVED_PREFIXES = ["SAND_"];

/** The connector name that means "the agent's own box shell environment". */
export const SHELL_SECRET_CONNECTOR = "shell";

/** True when `platform` names the shell destination rather than a connector or a chat channel. */
export function isShellSecretConnector(platform: unknown): boolean {
  return typeof platform === "string" && platform.trim().toLowerCase() === SHELL_SECRET_CONNECTOR;
}

/** The one rule. Every writer of the shell env store goes through it. */
export function isShellEnvSecretField(value: unknown): value is string {
  if (typeof value !== "string" || !SHELL_ENV_NAME_PATTERN.test(value)) return false;
  if (PROCESS_CONTROL_NAMES.has(value) || SHELL_IDENTITY_NAMES.has(value)) return false;
  if (value.endsWith("_PRELOAD")) return false;
  return ![...PROCESS_CONTROL_PREFIXES, ...RESERVED_PREFIXES].some((prefix) => value.startsWith(prefix));
}

/**
 * What the operator and the model are told when the name is refused. It names the rule rather than
 * the value, because the value was discarded and nothing was stored anywhere.
 */
export function shellEnvSecretFieldRefusal(field: unknown): string {
  const name = typeof field === "string" && field.length > 0 ? `"${field}"` : "an empty name";
  return `${name} is not a shell environment variable this host will set: the name must be UPPERCASE (A-Z, 0-9 and _), and process-control names (PATH, NODE_OPTIONS, LD_*), the shell's own identity (HOME, PWD, USER, SHELL) and the host's SAND_* switches are refused. Nothing was stored.`;
}
