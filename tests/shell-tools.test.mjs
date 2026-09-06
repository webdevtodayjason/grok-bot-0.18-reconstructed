// CONNECT-5. Shell tools: a CLI the agent runs from its own shell, with its credential in the
// environment.
//
// CodeRabbit ships no MCP server at all (docs/connectors/coderabbit.md), so the connector plane's
// rule -- an env key connectors.json leaves EMPTY is a credential -- has nothing to hang on. The
// shell store is that rule's sibling: same 0600 file, same env-name guard, its own section, and a
// destination one layer down.
//
// The claim these cases have to carry is not "a value was written to a file". It is that a stored
// value REACHES A SPAWNED SHELL and a deleted one does not, so the spawn here is the real one:
// BoxExecRuntime is the class inside the box that answers the agent's shell tool, `applyEnvironment`
// is what the host's update lands in, and `shell()` is what runs `/bin/sh -lc`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".shell-tools-test-"));
const root = mkdtempSync(path.join(tmpdir(), "shell-tools-"));
after(() => {
  rmSync(stage, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, name);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const shell = await bundle("source/host/extensions/shell-tools/shell-secrets.ts", "shell-secrets.cjs");
const catalog = await bundle("source/host/extensions/shell-tools/shell-tool-catalog.ts", "shell-tool-catalog.cjs");
const service = await bundle("source/host/extensions/shell-tools/shell-tools-service.ts", "shell-tools-service.cjs");
const connectorSecrets = await bundle("source/host/extensions/mcp/connector-secrets.ts", "connector-secrets-shared.cjs");
const daemon = await bundle("source/box-exec-daemon/server.ts", "box-exec-daemon.cjs");

const STORE = "connector-env-secrets.json";
const PROBE_FIELD = "CODERABBIT_API_KEY";
// Invented, and short-lived: it exists for the length of this file and is never a real key.
const PROBE_VALUE = `cr-probe-${Math.random().toString(36).slice(2, 12)}`;

// The one thing that makes this file's central claim real: a shell spawned by the same class the
// box runs, with the environment the host's update produced.
const runInBoxShell = async (runtime, command) => {
  const result = await runtime.shell(
    { command, workingDirectory: "", timeout: 0 },
    new AbortController().signal,
  );
  assert.equal(result.result.case, "success", `box shell failed: ${result.result.case}`);
  return result.result.value.stdout;
};

test("CONNECT-5: a stored shell credential reaches a spawned shell, and a deleted one does not", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "shell-tools-ws-"));
  const terminals = mkdtempSync(path.join(tmpdir(), "shell-tools-term-"));
  after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(terminals, { recursive: true, force: true });
  });
  // The daemon's own environment, minus anything of ours: whatever the shell sees below came from
  // the update, not from this test process.
  const runtime = new daemon.BoxExecRuntime(workspace, terminals, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  const probe = service.shellSecretProbeCommand(PROBE_FIELD);

  assert.equal(service.readShellSecretProbe(await runInBoxShell(runtime, probe)), "unset");

  assert.equal(shell.writeShellEnvSecret(root, PROBE_FIELD, PROBE_VALUE), true);
  const set = shell.buildShellSecretEnvironmentUpdate(root);
  assert.deepEqual(set, { env: { [PROBE_FIELD]: PROBE_VALUE }, replace: false });
  runtime.applyEnvironment(set);
  assert.equal(service.readShellSecretProbe(await runInBoxShell(runtime, probe)), "set");
  // The probe says whether, never what: the value must not be in what the shell printed.
  assert.ok(!(await runInBoxShell(runtime, probe)).includes(PROBE_VALUE));

  // The box control plane can set but not unset (replace mode would delete PATH and HOME with it),
  // so a delete pushes the empty string -- which `${VAR:+...}` reads as unset, and which the next
  // box restart drops for real.
  assert.equal(shell.deleteShellEnvSecret(root, PROBE_FIELD), true);
  const cleared = shell.buildShellSecretEnvironmentUpdate(root, [PROBE_FIELD]);
  assert.deepEqual(cleared, { env: { [PROBE_FIELD]: "" }, replace: false });
  runtime.applyEnvironment(cleared);
  assert.equal(service.readShellSecretProbe(await runInBoxShell(runtime, probe)), "unset");

  await runtime.stop();
});

test("CONNECT-5: the store is the connector store's file, 0600, in its own section", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shell-tools-store-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "connectors.json"), JSON.stringify({ mcpServers: { tinyfish: { command: "npx", args: [], env: { TINYFISH_API_KEY: "" } } } }), "utf8");

  assert.equal(connectorSecrets.writeConnectorEnvSecret(dir, "tinyfish", "TINYFISH_API_KEY", "connector-probe-value"), true);
  assert.equal(shell.writeShellEnvSecret(dir, PROBE_FIELD, PROBE_VALUE), true);

  const file = path.join(dir, STORE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const document = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(document).sort(), ["servers", "shell"]);
  assert.equal(document.shell[PROBE_FIELD], PROBE_VALUE);
  // Writing one section must not drop the other. The old writer serialized `{ servers }` and
  // would have deleted every shell credential on the next connector write.
  assert.deepEqual(connectorSecrets.listConnectorEnvSecretFields(dir, "tinyfish"), ["TINYFISH_API_KEY"]);
  assert.deepEqual(shell.listShellEnvSecretFields(dir), [PROBE_FIELD]);
  assert.equal(connectorSecrets.writeConnectorEnvSecret(dir, "tinyfish", "OTHER_TOKEN", "second-connector-value"), true);
  assert.deepEqual(shell.listShellEnvSecretFields(dir), [PROBE_FIELD]);
  assert.equal(shell.deleteShellEnvSecret(dir, PROBE_FIELD), true);
  assert.deepEqual(connectorSecrets.listConnectorEnvSecretFields(dir, "tinyfish"), ["OTHER_TOKEN", "TINYFISH_API_KEY"]);

  // Nothing is written into connectors.json, and a delete of something absent is not an error.
  assert.ok(!readFileSync(path.join(dir, "connectors.json"), "utf8").includes(PROBE_VALUE));
  assert.equal(shell.deleteShellEnvSecret(dir, PROBE_FIELD), false);
});

test("CONNECT-5: process-control names are refused here too", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shell-tools-guard-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // These names are process control, not credentials, and this value is merged into the
  // environment of the process that spawns every shell the agent runs.
  for (const bad of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV", "no-dashes", "1LEADING", ""]) {
    assert.equal(shell.writeShellEnvSecret(dir, bad, "x"), false, bad);
  }
  assert.deepEqual(shell.listShellEnvSecretFields(dir), []);
  // A hand-edited store carrying one is not read back either.
  writeFileSync(path.join(dir, STORE), JSON.stringify({ shell: { PATH: "/evil", GOOD_TOKEN: "kept" } }), { encoding: "utf8", mode: 0o600 });
  assert.deepEqual(shell.listShellEnvSecretFields(dir), ["GOOD_TOKEN"]);
  assert.deepEqual(shell.buildShellSecretEnvironmentUpdate(dir, ["PATH"]), { env: { GOOD_TOKEN: "kept" }, replace: false });
});

test("CONNECT-5: the catalog is the three tools, with the install and usage lines the reports name", () => {
  assert.deepEqual(catalog.SHELL_TOOLS.map((tool) => tool.id), ["coderabbit", "tinyfish-cli", "github-cli"]);
  assert.deepEqual([...catalog.SHELL_TOOL_FIELDS], ["CODERABBIT_API_KEY", "TINYFISH_API_KEY", "GITHUB_TOKEN"]);

  const coderabbit = catalog.findShellTool("coderabbit");
  assert.equal(coderabbit.field, "CODERABBIT_API_KEY");
  assert.equal(coderabbit.install, "CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh");
  assert.equal(coderabbit.usage, 'cr review --agent --api-key "$CODERABBIT_API_KEY"');
  // CodeRabbit is a CLI, not a connector: nothing here may look like an MCP entry.
  assert.equal(coderabbit.skillUrl, undefined);

  const tinyfish = catalog.findShellTool("tinyfish-cli");
  assert.equal(tinyfish.field, "TINYFISH_API_KEY");
  assert.equal(tinyfish.install, "pip install cli-anything-tinyfish");
  assert.match(tinyfish.skillUrl, /^https:\/\/raw\.githubusercontent\.com\/webdevtodayjason\/cli-anything-tinyfish\/.*SKILL\.md$/);

  assert.equal(catalog.findShellTool("nope"), undefined);
  assert.equal(catalog.findShellTool(undefined), undefined);
});

// QOL-GH. The GitHub CLI entry exists for git, not for gh's own subcommands: scribe committed in
// the box and could not push, because git over https with no credential helper has nowhere to get a
// username. So the two claims worth pinning are that the install follows GitHub's documented Linux
// routes and that it ends by giving git a helper -- an install that stops at `gh --version` leaves
// the bug exactly where it was.
test("QOL-GH: the gh entry installs from GitHub's documented routes and ends by configuring git", () => {
  const gh = catalog.findShellTool("github-cli");
  assert.equal(gh.field, "GITHUB_TOKEN");
  assert.equal(gh.binary, "gh");
  // gh reads this name itself; nothing in the install passes it on a command line, where the box's
  // own process table would carry it.
  assert.equal(gh.install.includes("$GITHUB_TOKEN"), false, "the token must not appear in the install command");
  assert.equal(gh.skillUrl, undefined);

  // The apt route, from docs/install_linux.md: the keyring, the signed-by source line, apt install.
  assert.match(gh.install, /cli\.github\.com\/packages\/githubcli-archive-keyring\.gpg/);
  assert.match(gh.install, /signed-by=\/etc\/apt\/keyrings\/githubcli-archive-keyring\.gpg\] https:\/\/cli\.github\.com\/packages stable main/);
  assert.match(gh.install, /apt-get install -y gh/);
  // The fallback, for a box with no apt or no root: the precompiled tarball into ~/.local/bin,
  // which is where the other two installers land their binary and where `sh -lc` finds it.
  assert.match(gh.install, /github\.com\/cli\/cli\/releases\/download\//);
  assert.match(gh.install, /\$HOME\/\.local\/bin/);

  // The half the bug was about.
  assert.match(gh.install, /gh auth setup-git --hostname github\.com/);
  assert.match(gh.install, /credential\."https:\/\/github\.com"\.helper '!gh auth git-credential'/);
  // And the install proves it landed rather than assuming it: `set -e` plus a read of the key.
  assert.match(gh.install, /^set -e$/m);
  assert.match(gh.install, /git config --global --get-regexp/);
});

test("CONNECT-5: installer output comes back as a tail, with any stored value struck out", () => {
  assert.equal(service.tailLines("a\nb\nc\nd", 2), "c\nd");
  assert.equal(service.tailLines("only\n", 5), "only");
  assert.equal(
    service.redactShellSecretValues(`installed with ${PROBE_VALUE} ok`, [PROBE_VALUE]),
    "installed with [redacted] ok",
  );
  // A one-character "secret" would redact the whole page; nothing that short is a credential.
  assert.equal(service.redactShellSecretValues("abc", ["a"]), "abc");
});

test("CONNECT-5: the skill import fetches the tool's own SKILL.md and refuses an empty one", async () => {
  const tinyfish = catalog.findShellTool("tinyfish-cli");
  const answered = await service.fetchShellToolSkill(tinyfish, async (url) => {
    assert.equal(url, tinyfish.skillUrl);
    return { ok: true, status: 200, text: async () => "# TinyFish\nRun it.\n" };
  });
  assert.match(answered, /TinyFish/);

  await assert.rejects(
    () => service.fetchShellToolSkill(tinyfish, async () => ({ ok: false, status: 404, text: async () => "" })),
    /404/,
  );
  await assert.rejects(
    () => service.fetchShellToolSkill(tinyfish, async () => ({ ok: true, status: 200, text: async () => "   " })),
    /empty document/,
  );
  await assert.rejects(
    () => service.fetchShellToolSkill(catalog.findShellTool("coderabbit"), async () => { throw new Error("must not be called"); }),
    /publishes no skill/,
  );
});
