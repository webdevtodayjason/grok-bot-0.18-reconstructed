/**
 * CONNECT-5. The shell tools this box knows how to install and how to hand a key to.
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
 *
 * QOL-GH. The GitHub CLI entry is the one that exists for git rather than for the agent's own
 * commands. An agent that commits in the box could not push: `git pull` answered "could not read
 * Username for https://github.com", because a non-interactive git with no credential helper has
 * nowhere to get one and prompts into a shell nobody is typing at. `gh auth setup-git` is GitHub's
 * own answer -- it writes `credential.https://github.com.helper = !gh auth git-credential` into the
 * box user's global git config, and from then on every https fetch and push asks `gh`, which reads
 * GITHUB_TOKEN out of the environment the shell secret store already merges in. So the credential
 * plane that fills `cr review --api-key` fills `git push` too, and nothing about it is a git
 * remote's URL, a `.netrc`, or a token in a file the agent can read back.
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

/**
 * QOL-GH. The GitHub CLI install, written as lines rather than one string so the card can show it
 * and a reader can check it against https://github.com/cli/cli/blob/trunk/docs/install_linux.md.
 *
 * Two routes because the box is one container and this file cannot know which: the documented
 * Debian/Ubuntu apt repository when apt-get is there AND this user can reach root without a
 * password, and otherwise the official precompiled tarball into `~/.local/bin` -- the same place
 * the other two catalog installers land their binary, and the reason `probeShellToolBinary` spawns
 * `/bin/sh -lc` from home. An already-installed `gh` skips straight to the git half.
 *
 * The last two lines are the point of the entry. `gh auth setup-git` is the documented command;
 * it needs a token to name a host, so when the key has not been stored yet it exits non-zero and
 * the fallback writes the same helper by hand -- the helper does not need the token until git
 * actually calls it. The final `git config --get-regexp` is the install's own proof: with
 * `set -e`, an install that did not leave a credential helper behind fails on the card rather than
 * reporting success and leaving `git push` to discover it.
 */
const GITHUB_CLI_INSTALL = [
  "set -e",
  'PATH="$HOME/.local/bin:$PATH"; export PATH',
  "if command -v gh >/dev/null 2>&1; then",
  '  echo "gh is already installed: $(command -v gh)"',
  "else",
  '  if [ "$(id -u)" = 0 ]; then S=""; elif sudo -n true >/dev/null 2>&1; then S="sudo"; else S="-"; fi',
  '  if [ "$S" != "-" ] && command -v apt-get >/dev/null 2>&1; then',
  "    # github.com/cli/cli/blob/trunk/docs/install_linux.md -- the official apt repository",
  "    $S mkdir -p -m 755 /etc/apt/keyrings /etc/apt/sources.list.d",
  "    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $S tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null",
  "    $S chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
  '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $S tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
  "    $S apt-get update",
  "    $S env DEBIAN_FRONTEND=noninteractive apt-get install -y gh",
  "  else",
  "    # No apt, or no root here: the same docs' precompiled binaries, into ~/.local/bin.",
  "    v=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest); v=${v##*/tag/v}",
  "    a=$(uname -m); case \"$a\" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; armv6*|armv7*) a=armv6;; i?86) a=386;; esac",
  '    t=$(mktemp -d); curl -fsSL "https://github.com/cli/cli/releases/download/v$v/gh_${v}_linux_$a.tar.gz" | tar -xz -C "$t"',
  '    mkdir -p "$HOME/.local/bin"; install -m 755 "$t"/gh_*/bin/gh "$HOME/.local/bin/gh"; rm -rf "$t"',
  "  fi",
  "fi",
  "gh --version",
  "gh auth setup-git --hostname github.com || git config --global credential.\"https://github.com\".helper '!gh auth git-credential'",
  "git config --global --get-regexp '^credential\\..*helper$'",
].join("\n");

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
  Object.freeze({
    id: "github-cli",
    name: "GitHub CLI (gh)",
    field: "GITHUB_TOKEN",
    binary: "gh",
    install: GITHUB_CLI_INSTALL,
    usage:
      "Nothing, for git: once the helper is configured `git pull` and `git push` over https authenticate "
      + "themselves. `gh pr create`, `gh issue list` and `gh api` read the same GITHUB_TOKEN.",
    credentialNote:
      "A fine-grained personal access token from github.com/settings/personal-access-tokens/new, scoped to "
      + "one owner and the repositories it may touch (docs/connectors/github.md). Pushing needs Contents: "
      + "write on those repositories; Metadata: read comes with it. This is the SHELL's copy: the github "
      + "connector's GITHUB_PERSONAL_ACCESS_TOKEN is a different name in a different environment, and "
      + "storing one does not fill the other.",
  }),
] as const);

/** Every environment variable name the catalog claims. The console draws one credential row each. */
export const SHELL_TOOL_FIELDS: readonly string[] = Object.freeze(SHELL_TOOLS.map((tool) => tool.field));

export function findShellTool(id: unknown): ShellToolEntry | undefined {
  return typeof id === "string" ? SHELL_TOOLS.find((tool) => tool.id === id) : undefined;
}
