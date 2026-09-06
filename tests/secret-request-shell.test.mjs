// SECRET-1. The inline credential card whose value lands in the AGENT'S OWN box shell.
//
// The ask, from the original product: an agent asks for a "Titan Job Bus token" on a masked card
// that says "it'll land as env TITAN_JOB_TOKEN for this box", and the value becomes an environment
// variable of that agent's shell. Every other destination routeSecret knows is somebody else's
// process -- an MCP server's env, a chat channel's credential file -- and the shell store from
// CONNECT-5 already IS the agent's shell environment, so the missing piece was a NAME.
//
// These cases pin the parts that are pure: the reserved connector name routes to the shell sink
// and nowhere else, a refused variable name stores nothing anywhere, the connector and channel
// branches are untouched, the ack the model reads names the variable, and the tool schema refuses
// a bad name before a human is ever shown a card the host cannot honour.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".secret-request-shell-test-"));
const root = mkdtempSync(path.join(tmpdir(), "secret-request-shell-"));
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

const widgets = await bundle("source/host/extensions/transcript/widget-responses.ts", "widget-responses.cjs");
const ack = await bundle("source/host/runner/tools/sand-secret-request.ts", "sand-secret-request.cjs");
const schema = await bundle("source/host/runner/tools/send-message-schema.ts", "send-message-schema.cjs");
const field = await bundle("source/host/extensions/shell-tools/shell-secret-field.ts", "shell-secret-field.cjs");

const target = (platform, name) => ({ kind: "channel-credential", platform, field: name });
const probeValue = () => `PROBE-SECRET-${Math.random().toString(36).slice(2, 12).toUpperCase()}`;

/**
 * A WidgetResponses over a recording transcript manager. Both sinks and the channel store are
 * real functions that record what reached them, so "the sink was never called" is a fact this
 * test can state rather than infer.
 */
function harness(overrides = {}) {
  const seen = { shell: [], connector: [], channel: [] };
  const responses = new widgets.WidgetResponses({
    shellSecretSink: async ({ field: name, value }) => {
      seen.shell.push({ field: name, value });
      return { field: name, stored: true, applied: overrides.applied !== false };
    },
    connectorSecretSink: async ({ server, field: name, value }) => {
      seen.connector.push({ server, field: name, value });
      return { server, serverId: "1000", field: name, stored: true, restarted: true };
    },
    sessionStore: {
      storeConnectorCredential: (agentId, platform, name, value) => {
        seen.channel.push({ agentId, platform, field: name, value });
        return true;
      },
    },
    channelConfigChanged: () => {},
    ...overrides.tm,
  });
  return { responses, seen };
}

test('SECRET-1: connector "shell" routes the value into the agent\'s own shell environment', async () => {
  const { responses, seen } = harness();
  const value = probeValue();
  const routed = await responses.routeSecret("agent1", target("shell", "TITAN_JOB_TOKEN"), value);

  assert.deepEqual(seen.shell, [{ field: "TITAN_JOB_TOKEN", value }]);
  assert.equal(routed.shellField, "TITAN_JOB_TOKEN");
  assert.equal(routed.applied, true);
  assert.equal(routed.destination, "your shell's environment as $TITAN_JOB_TOKEN");
  // The whole point of the reserved name: it must not also reach a store the agent can read back,
  // nor an MCP server's process env.
  assert.deepEqual(seen.channel, []);
  assert.deepEqual(seen.connector, []);
  // The name is not case sensitive on the way in -- the model writes the connector name -- but the
  // VARIABLE is, and the destination string carries the variable exactly as it will be set.
  const upper = await responses.routeSecret("agent1", target("Shell", "TITAN_JOB_TOKEN"), value);
  assert.equal(upper.destination, "your shell's environment as $TITAN_JOB_TOKEN");
});

test("SECRET-1: a variable name the host will not set stores nothing, anywhere", async () => {
  for (const name of ["PATH", "SAND_TOOL_TRACE", "titan_job_token", "LD_PRELOAD", "HOME", ""]) {
    const { responses, seen } = harness();
    const routed = await responses.routeSecret("agent1", target("shell", name), probeValue());
    assert.ok("refused" in routed, `${name || "(empty)"} was not refused`);
    assert.match(routed.refused, /Nothing was stored\./);
    assert.equal(routed.destination, undefined);
    // Refused means refused: not stored in the shell, not written to a connector, and above all
    // not fallen through to the per-agent channel file the agent can cat.
    assert.deepEqual(seen.shell, []);
    assert.deepEqual(seen.connector, []);
    assert.deepEqual(seen.channel, []);
  }
});

test("SECRET-1: the connector and channel branches are unchanged by the new name", async () => {
  const value = probeValue();

  const connector = harness();
  const routedConnector = await connector.responses.routeSecret("agent1", target("tinyfish", "TINYFISH_API_KEY"), value);
  assert.equal(routedConnector.server, "tinyfish");
  assert.equal(routedConnector.destination, "the connector's process environment");
  assert.equal(routedConnector.shellField, undefined);
  assert.deepEqual(connector.seen.shell, []);

  // slack and github stay chat platforms: they win the name race against a local connector, and
  // the shell name must not have changed that.
  const channel = harness();
  const routedChannel = await channel.responses.routeSecret("agent1", target("slack", "token"), value);
  assert.equal(routedChannel.destination, "channel-credential");
  assert.deepEqual(channel.seen.shell, []);
  assert.deepEqual(channel.seen.connector, []);
  assert.equal(channel.seen.channel.length, 1);
});

test("SECRET-1: the ack the model reads names the variable and whether the box took it", () => {
  const request = { label: "Titan Job Bus token", target: { kind: "channel-credential" } };
  const applied = ack.buildSecretProvidedAck(request, {
    destination: "your shell's environment as $TITAN_JOB_TOKEN", shellField: "TITAN_JOB_TOKEN", applied: true,
  });
  assert.match(applied, /It is set in your shell's environment as \$TITAN_JOB_TOKEN; commands you run from now on see it \(applied: yes\)\./);
  assert.match(applied, /you never see the value and it is not in this conversation/);

  // "Stored" and "your next command sees it" are two claims, and the beat must not merge them.
  const pending = ack.buildSecretProvidedAck(request, {
    destination: "your shell's environment as $TITAN_JOB_TOKEN", shellField: "TITAN_JOB_TOKEN", applied: false,
  });
  assert.match(pending, /\(applied: no\)\./);
  assert.match(pending, /do not report it usable yet/);

  // The connector beat is untouched.
  const connector = ack.buildSecretProvidedAck(request, {
    destination: "the connector's process environment", server: "tinyfish", restarted: true,
  });
  assert.match(connector, /"tinyfish" connector was restarted with it/);
  assert.doesNotMatch(connector, /shell's environment/);
});

test("SECRET-1: the tool schema takes a shell request only with a variable name it can set", () => {
  const send = (secret) => schema.sendMessageParameters.safeParse({ type: "secret-request", secret });
  const good = send({ label: "Titan Job Bus token", connector: "shell", field: "TITAN_JOB_TOKEN" });
  assert.equal(good.success, true, JSON.stringify(good.error?.issues));

  for (const name of ["path", "PATH", "SAND_PROFILE_DIRS", "titan_job_token", "TITAN-JOB-TOKEN"]) {
    const bad = send({ label: "Titan Job Bus token", connector: "shell", field: name });
    assert.equal(bad.success, false, `${name} was accepted`);
    const issue = bad.error.issues.find((entry) => entry.path.join(".") === "secret.field");
    assert.ok(issue, `${name} was refused without pointing at secret.field`);
    assert.match(issue.message, /UPPERCASE variable name/);
  }

  // Every other connector name keeps taking the field names it always took -- the shell rule is
  // scoped to the reserved name and nothing else.
  const connector = send({ label: "TinyFish key", connector: "tinyfish", field: "token" });
  assert.equal(connector.success, true, JSON.stringify(connector.error?.issues));
});

test("SECRET-1: the shell field rule is one rule, and it is the strict one", () => {
  assert.equal(field.SHELL_SECRET_CONNECTOR, "shell");
  assert.equal(field.isShellSecretConnector(" Shell "), true);
  assert.equal(field.isShellSecretConnector("tinyfish"), false);
  assert.equal(field.isShellEnvSecretField("TITAN_JOB_TOKEN"), true);
  assert.equal(field.isShellEnvSecretField("GITHUB_TOKEN"), true);
  assert.equal(field.isShellEnvSecretField("NODE_OPTIONS"), false);
  assert.equal(field.isShellEnvSecretField("SAND_TOOL_TRACE"), false);
  assert.equal(field.isShellEnvSecretField("HOME"), false);
  assert.equal(field.isShellEnvSecretField("_TOKEN"), false);
  assert.equal(field.isShellEnvSecretField("token"), false);
  // The refusal names the rule, never the value that was discarded.
  assert.match(field.shellEnvSecretFieldRefusal("path"), /UPPERCASE/);
  assert.match(field.shellEnvSecretFieldRefusal(""), /an empty name/);
});
