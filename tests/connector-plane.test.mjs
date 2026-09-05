// Wave D1: the two files a connector's identity and its credentials actually live in.
//
// CP-07: local connectors were minted `local:<name>`, and every id-keyed MCP operation runs its
// argument through validateMcpServerId (/^[1-9]\d*$/), so instructions, per-tool toggles and
// authenticate rejected exactly the connectors that work on this box. CP-10: a submitted secret
// landed in the per-agent chat-channel store, which no MCP code reads and the agent can cat.
//
// These cases pin the parts that are pure: an id is a positive integer, it is persisted, it does
// not move when a second connector appears, and a stored secret reaches the spawn spec's env
// without ever being written into connectors.json.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".connector-plane-test-"));
const root = mkdtempSync(path.join(tmpdir(), "connector-plane-"));
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

const connectors = await bundle("source/host/extensions/mcp/local-connectors.ts", "local-connectors.cjs");
const secrets = await bundle("source/host/extensions/mcp/connector-secrets.ts", "connector-secrets.cjs");
const ack = await bundle("source/host/runner/tools/sand-secret-request.ts", "sand-secret-request.cjs");
const widgets = await bundle("source/host/extensions/transcript/widget-responses.ts", "widget-responses.cjs");
const channelStore = await bundle("source/host/extensions/session/connector-secret-store.ts", "connector-secret-store.cjs");

const writeConnectors = (servers) =>
  writeFileSync(path.join(root, "connectors.json"), JSON.stringify({ mcpServers: servers }), "utf8");

test("CP-07: a local connector's id is a positive integer that survives a restart", () => {
  writeConnectors({ localfiles: { command: "npx", args: ["-y", "server-filesystem", "/workspace"] } });
  const first = connectors.assignLocalConnectorIds(root, ["localfiles"]);
  assert.match(first.localfiles, /^[1-9]\d*$/);
  assert.ok(Number(first.localfiles) >= connectors.LOCAL_CONNECTOR_ID_FLOOR);
  // "Survives a restart" is the file, not the process: a fresh read of the same directory.
  assert.deepEqual(connectors.assignLocalConnectorIds(root, ["localfiles"]), first);
  const idsFile = path.join(root, connectors.LOCAL_CONNECTOR_IDS_FILENAME);
  assert.equal(statSync(idsFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(idsFile, "utf8")).ids.localfiles, Number(first.localfiles));

  // A second connector never renumbers the first.
  const both = connectors.assignLocalConnectorIds(root, ["localfiles", "probe"]);
  assert.equal(both.localfiles, first.localfiles);
  assert.notEqual(both.probe, both.localfiles);
  assert.ok(Number(both.probe) >= connectors.LOCAL_CONNECTOR_ID_FLOOR);
});

test("CP-07: an id is a function of the name, not of who else is configured", () => {
  // The persisted map is best-effort. When it cannot be written, a counter handed out in sorted
  // order gives a connector a different id as soon as a name sorting before it appears -- and both
  // mcpDisabledToolsByServerId and mcpCustomInstructionsByServerId are keyed by that id, so the
  // renumber moves one connector's disabled tools and instruction onto another.
  const fresh = mkdtempSync(path.join(tmpdir(), "connector-plane-order-"));
  const other = mkdtempSync(path.join(tmpdir(), "connector-plane-order-"));
  after(() => { rmSync(fresh, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const alone = connectors.assignLocalConnectorIds(fresh, ["localfiles"]);
  const beside = connectors.assignLocalConnectorIds(other, ["alpha", "localfiles"]);
  assert.equal(beside.localfiles, alone.localfiles);
  assert.equal(alone.localfiles, String(connectors.localConnectorIdForName("localfiles")));
  assert.notEqual(beside.alpha, beside.localfiles);
});

test("CP-07: a read-only resolution mints no file", () => {
  const fresh = mkdtempSync(path.join(tmpdir(), "connector-plane-readonly-"));
  after(() => rmSync(fresh, { recursive: true, force: true }));
  const ids = connectors.assignLocalConnectorIds(fresh, ["localfiles"], { readOnly: true });
  assert.equal(ids.localfiles, String(connectors.localConnectorIdForName("localfiles")));
  assert.throws(() => statSync(path.join(fresh, connectors.LOCAL_CONNECTOR_IDS_FILENAME)));
});

test("CP-07: the merged account row carries the numeric id and keeps the name as its identifier", () => {
  const local = connectors.readLocalConnectorFile(root);
  const ids = connectors.assignLocalConnectorIds(root, Object.keys(local));
  const merged = connectors.mergeLocalConnectors(null, local, { ids });
  const row = merged.servers.find((server) => server.name === "localfiles");
  assert.equal(row.id, ids.localfiles);
  assert.equal(row.serverIdentifier, "localfiles");
  // Without the ids the old string id is still what comes back, so nothing that never learned
  // about the map silently gets a different shape.
  assert.equal(connectors.mergeLocalConnectors(null, local).servers[0].id, "local:localfiles");
});

test("CP-10: a stored secret reaches the spawn env and never reaches connectors.json", () => {
  const probe = `PROBE-SECRET-${Math.random().toString(36).slice(2, 10)}`;
  assert.equal(secrets.writeConnectorEnvSecret(root, "localfiles", "PROBE_SECRET", probe), true);
  assert.deepEqual(secrets.listConnectorEnvSecretFields(root, "localfiles"), ["PROBE_SECRET"]);

  const store = path.join(root, secrets.CONNECTOR_ENV_SECRETS_FILENAME);
  assert.equal(statSync(store).mode & 0o777, 0o600);
  assert.ok(readFileSync(store, "utf8").includes(probe));
  assert.ok(!readFileSync(path.join(root, "connectors.json"), "utf8").includes(probe));

  const local = connectors.readLocalConnectorFile(root);
  const merged = connectors.mergeLocalConnectors(null, local, {
    ids: connectors.assignLocalConnectorIds(root, Object.keys(local)),
    secrets: secrets.readConnectorEnvSecrets(root),
  });
  assert.equal(merged.servers.find((server) => server.name === "localfiles").config.env.PROBE_SECRET, probe);

  assert.equal(secrets.deleteConnectorEnvSecret(root, "localfiles", "PROBE_SECRET"), true);
  assert.deepEqual(secrets.listConnectorEnvSecretFields(root, "localfiles"), []);
  assert.equal(secrets.deleteConnectorEnvSecret(root, "localfiles", "PROBE_SECRET"), false);
});

test("CP-10: the store is rewritten atomically and stays 0600 even when it was loose", () => {
  const fresh = mkdtempSync(path.join(tmpdir(), "connector-plane-mode-"));
  after(() => rmSync(fresh, { recursive: true, force: true }));
  const store = path.join(fresh, secrets.CONNECTOR_ENV_SECRETS_FILENAME);
  // A store left world-readable by an earlier build or an operator: writeFileSync applies `mode`
  // only when it CREATES the file, so the old write inherited 0644 and the 0600 promise was false.
  writeFileSync(store, JSON.stringify({ servers: {} }), { encoding: "utf8", mode: 0o644 });
  assert.equal(secrets.writeConnectorEnvSecret(fresh, "localfiles", "PROBE_SECRET", "PROBE-SECRET-mode"), true);
  assert.equal(statSync(store).mode & 0o777, 0o600);
  assert.deepEqual(secrets.listConnectorEnvSecretFields(fresh, "localfiles"), ["PROBE_SECRET"]);
});

test("CP-10: process-control env names are refused, not stored", () => {
  // The field name is picked by the model and the label the human reads is written by that same
  // model, so a "paste your API token" prompt must not be able to set NODE_OPTIONS on a connector
  // this host spawns.
  for (const bad of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PERL5OPT", "BASH_ENV", "SOMETHING_PRELOAD"]) {
    assert.equal(secrets.isConnectorEnvFieldName(bad), false, bad);
    assert.equal(secrets.writeConnectorEnvSecret(root, "localfiles", bad, "x"), false, bad);
  }
  assert.deepEqual(secrets.listConnectorEnvSecretFields(root, "localfiles"), []);
});

test("CP-10: only an environment variable name can name a connector secret", () => {
  for (const bad of ["", "no-dashes", "1LEADING_DIGIT", "with space", "sh;rm -rf /"]) {
    assert.equal(secrets.isConnectorEnvFieldName(bad), false, bad);
    assert.equal(secrets.writeConnectorEnvSecret(root, "localfiles", bad, "x"), false, bad);
  }
  assert.equal(secrets.isConnectorEnvFieldName("PROBE_SECRET"), true);
});

test("CP-10: the ack beat says what actually happened to the value", () => {
  const request = { label: "the probe key", target: { kind: "channel-credential" } };
  const restarted = ack.buildSecretProvidedAck(request, {
    destination: "the connector's process environment", server: "localfiles", restarted: true,
  });
  assert.match(restarted, /"localfiles" connector was restarted/);
  const notRestarted = ack.buildSecretProvidedAck(request, {
    destination: "the connector's process environment", server: "localfiles", restarted: false,
  });
  assert.match(notRestarted, /did not restart/);
  // A chat credential keeps the old beat; it did not restart anything and must not claim to.
  const channel = ack.buildSecretProvidedAck(request, { destination: "channel-credential" });
  assert.ok(!/restart/.test(channel));
});

// CONNECT-4. The card used to offer every env key of the entry as "Enter securely", so
// MCP_REMOTE_CONFIG_DIR -- a directory path the operator wrote themselves -- came up as a
// credential field and swallowed a pasted API key: the connector then started with a config dir
// named after the key and no credential at all. The host is the authority on which env keys are
// credentials, and the rule is the empty value.
const connectorRoot = (servers) => {
  const dir = mkdtempSync(path.join(tmpdir(), "connector-credential-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "connectors.json"), JSON.stringify({ mcpServers: servers }), "utf8");
  return dir;
};

const TINYFISH_ENTRY = {
  command: "npx",
  args: ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp", "--transport", "http-only",
    "--header", "Authorization:Bearer ${TINYFISH_API_KEY}"],
  env: { TINYFISH_API_KEY: "", MCP_REMOTE_CONFIG_DIR: "/home/box/.mcp-auth" },
};

test("CONNECT-4: an empty env value is a credential field, a filled one is configuration", () => {
  const dir = connectorRoot({ tinyfish: TINYFISH_ENTRY });
  assert.deepEqual(secrets.listConnectorCredentialFields(dir, "tinyfish"), ["TINYFISH_API_KEY"]);
  assert.doesNotThrow(() => secrets.assertConnectorCredentialField(dir, "tinyfish", "TINYFISH_API_KEY"));

  assert.throws(
    () => secrets.assertConnectorCredentialField(dir, "tinyfish", "MCP_REMOTE_CONFIG_DIR"),
    (error) => {
      // The message names the rule, because the person reading it wrote the entry and the fix is
      // in that entry. It names no VALUE from connectors.json: the refusal is not a read primitive.
      assert.match(error.message, /MCP_REMOTE_CONFIG_DIR/);
      assert.match(error.message, /empty string/);
      assert.match(error.message, /configuration, not a credential/);
      assert.match(error.message, /TINYFISH_API_KEY/);
      assert.ok(!error.message.includes("/home/box/.mcp-auth"));
      return true;
    },
  );

  // A process-control name is not rescued by an empty value: an entry could otherwise make the
  // card offer a field writeConnectorEnvSecret refuses anyway.
  const hostile = connectorRoot({ tinyfish: { ...TINYFISH_ENTRY, env: { PATH: "", LD_PRELOAD: "" } } });
  assert.deepEqual(secrets.listConnectorCredentialFields(hostile, "tinyfish"), []);
  assert.throws(() => secrets.assertConnectorCredentialField(hostile, "tinyfish", "PATH"), /not a credential/);
});

test("CONNECT-4: a stored field stays on the list after its entry is edited away", () => {
  // Otherwise a credential stored before the entry changed becomes invisible on the card and
  // undeletable through it, while the value stays in the store for the life of the box.
  const dir = connectorRoot({ tinyfish: TINYFISH_ENTRY });
  assert.equal(secrets.writeConnectorEnvSecret(dir, "tinyfish", "TINYFISH_API_KEY", "PROBE-SECRET-stored"), true);
  writeFileSync(path.join(dir, "connectors.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  assert.deepEqual(secrets.listConnectorCredentialFields(dir, "tinyfish"), ["TINYFISH_API_KEY"]);

  // And the union is a union: above, the stored field and the entry's empty key are the same name,
  // so a second field proves both halves are read.
  const both = connectorRoot({ tinyfish: TINYFISH_ENTRY });
  assert.equal(secrets.writeConnectorEnvSecret(both, "tinyfish", "OLD_TOKEN", "PROBE-SECRET-old"), true);
  assert.deepEqual(secrets.listConnectorCredentialFields(both, "tinyfish"), ["OLD_TOKEN", "TINYFISH_API_KEY"]);
});

test("CONNECT-4: the merge into the connector process env is unchanged", () => {
  const dir = connectorRoot({ tinyfish: TINYFISH_ENTRY });
  const spawnConfig = (rootDir) => {
    const local = connectors.readLocalConnectorFile(rootDir);
    return connectors.mergeLocalConnectors(null, local, {
      ids: connectors.assignLocalConnectorIds(rootDir, Object.keys(local)),
      secrets: secrets.readConnectorEnvSecrets(rootDir),
    }).servers.find((server) => server.name === "tinyfish").config;
  };

  // With nothing stored the connector still starts, with the placeholder empty: that is what makes
  // "no key yet" a connector that fails to authenticate rather than one that never launches.
  const before = spawnConfig(dir);
  assert.equal(before.env.TINYFISH_API_KEY, "");
  assert.deepEqual(before.args, TINYFISH_ENTRY.args);

  const probe = `PROBE-SECRET-${Math.random().toString(36).slice(2, 10)}`;
  assert.equal(secrets.writeConnectorEnvSecret(dir, "tinyfish", "TINYFISH_API_KEY", probe), true);
  const after = spawnConfig(dir);
  assert.equal(after.env.TINYFISH_API_KEY, probe);
  // Configuration is untouched by the rule -- it is still handed to the process, just never asked
  // for as a credential -- and the header argument reaches the process unexpanded.
  assert.equal(after.env.MCP_REMOTE_CONFIG_DIR, "/home/box/.mcp-auth");
  assert.deepEqual(after.args, TINYFISH_ENTRY.args);
  assert.ok(!readFileSync(path.join(dir, "connectors.json"), "utf8").includes(probe));
});

test("CONNECT-4: a refused field is not written to the per-agent channel store", async () => {
  // The refusal has a consumer: the secure-input widget. Its catch used to log and fall through to
  // `connector-secrets/<agentId>/<platform>.json` -- the per-agent store no MCP code reads and the
  // agent CAN read back -- so tightening setConnectorSecret would have turned every refused field
  // into a value sitting where the agent could cat it, with the operator told it worked.
  const dir = connectorRoot({ tinyfish: TINYFISH_ENTRY });
  const store = new channelStore.SandConnectorSecretStore(path.join(dir, "connector-secrets"));
  const responses = new widgets.WidgetResponses({
    // The real sink: local connector, then the host's own rule. Nothing about it is stubbed except
    // the restart it would do on success.
    connectorSecretSink: async ({ server, field, value }) => {
      secrets.assertConnectorCredentialField(dir, server, field);
      assert.equal(secrets.writeConnectorEnvSecret(dir, server, field, value), true);
      return { server, serverId: "1000", field, stored: true, restarted: true };
    },
    sessionStore: {
      storeConnectorCredential: (agentId, platform, field, value) =>
        store.setSecret(agentId, platform, field, value),
    },
    channelConfigChanged: () => {},
  });
  const target = (field) => ({ kind: "channel-credential", platform: "tinyfish", field });
  const probe = `PROBE-SECRET-${Math.random().toString(36).slice(2, 10)}`;

  const refused = await responses.routeSecret("agent1", target("MCP_REMOTE_CONFIG_DIR"), probe);
  assert.match(refused.refused, /configuration, not a credential/);
  assert.equal(refused.destination, undefined);
  assert.equal(existsSync(store.filePath("agent1", "tinyfish")), false);
  assert.equal(existsSync(path.join(dir, secrets.CONNECTOR_ENV_SECRETS_FILENAME)), false);

  // And the field the entry does declare still routes to the connector, untouched by the guard.
  const accepted = await responses.routeSecret("agent1", target("TINYFISH_API_KEY"), probe);
  assert.equal(accepted.server, "tinyfish");
  assert.equal(accepted.restarted, true);
  assert.equal(existsSync(store.filePath("agent1", "tinyfish")), false);
});
