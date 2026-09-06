/**
 * CONNECT-5. The two shell tools this box knows how to install and how to hand a key to.
 *
 * A "shell tool" is a command-line program the agent runs from its own shell, with a credential in
 * the environment. It is not an MCP server: nothing here appears in connectors.json, nothing here
 * shows up in `tools/list`, and the host spawns nothing on its behalf. The catalog exists so the
 * console can draw a card per entry instead of the operator running `docker exec` by hand -- which
 * is the whole point of the connectors wave.
 *
 * The CodeRabbit entry is docs/connectors/coderabbit.md verbatim: there IS no CodeRabbit MCP
 * server (the official product is an MCP *client*, and the three community servers are
 * unmaintained, archived, or read GitHub comments rather than run reviews), so the integration is
 * the official CLI with an Agentic API key passed on every run. `CI=1` skips the installer's
 * browser prompt.
 *
 * The TinyFish entry is the operator's own `cli-anything-tinyfish`: a pip package that reads
 * `TINYFISH_API_KEY` out of the environment, with a published SKILL.md that teaches an agent how
 * to drive it. That SKILL.md is imported as an agent workflow rather than restated here, so the
 * skill the agent gets is the one its author maintains.
 */
export interface ShellToolEntry {
  /** Stable id. The gateway commands and the console cards are keyed by it. */
  readonly id: string;
  readonly name: string;
  /** The one environment variable this tool reads. Stored in the shell secret store, never here. */
  readonly field: string;
  /**
   * The program the install puts on the box's PATH. `command -v <binary>` in the box's own shell is
   * the only true "is it installed" signal this host has: nothing records a shell-tool install, and
   * a stored key is a different fact entirely -- a key with no program is a command that does not
   * exist, and a program with no key is installed but unusable.
   */
  readonly binary: string;
  /** Run inside the box as user `box`. Never run by the gate. */
  readonly install: string;
  /** What the agent is meant to type once the tool is installed and the key is stored. */
  readonly usage: string;
  /** Card copy: where the key comes from, in the provider's own terms. */
  readonly credentialNote: string;
  /** A SKILL.md to import as this agent's workflow, where the tool publishes one. */
  readonly skillUrl?: string;
}

export const SHELL_TOOLS: readonly ShellToolEntry[] = Object.freeze([
  Object.freeze({
    id: "coderabbit",
    name: "CodeRabbit CLI",
    field: "CODERABBIT_API_KEY",
    binary: "cr",
    install: "CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh",
    usage: `cr review --agent --api-key "$CODERABBIT_API_KEY"`,
    credentialNote:
      "An Agentic API key from app.coderabbit.ai/settings/api-keys (app.eu.coderabbit.ai for EU accounts). "
      + "User and workspace keys are a different product and the CLI refuses them. The key is org-bound and "
      + "the org it belongs to is billed for CLI reviews.",
  }),
  Object.freeze({
    id: "tinyfish-cli",
    name: "TinyFish CLI",
    field: "TINYFISH_API_KEY",
    binary: "cli-anything-tinyfish",
    install: "pip install cli-anything-tinyfish",
    usage: "TINYFISH_API_KEY is read from the environment; the imported skill documents the commands.",
    credentialNote:
      "The same TinyFish API key the tinyfish connector uses. Storing it here puts it in the agent's shell "
      + "environment, which is a different place from the connector's process environment -- a key stored on "
      + "the tinyfish connector card does not reach this CLI.",
    skillUrl:
      "https://raw.githubusercontent.com/webdevtodayjason/cli-anything-tinyfish/main/cli_anything/tinyfish/skills/SKILL.md",
  }),
] as const);

/** Every environment variable name the catalog claims. The console draws one credential row each. */
export const SHELL_TOOL_FIELDS: readonly string[] = Object.freeze(SHELL_TOOLS.map((tool) => tool.field));

export function findShellTool(id: unknown): ShellToolEntry | undefined {
  return typeof id === "string" ? SHELL_TOOLS.find((tool) => tool.id === id) : undefined;
}
