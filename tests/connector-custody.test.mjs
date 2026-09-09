// MARKET-6, the review pass: the three things the first ship got wrong about custody and reach,
// each one a measurement someone took on a live box turned into something that runs in half a
// second.
//
//   THE ARGV LEAK SURVIVED THE SHIP. Moving to the native remote shape changed what a NEW entry is
//   written as. Both R750 boxes kept the bridged TinyFish entry they were given in July, so the
//   stored bearer was still in three root process argument lists in each on 2026-09-08, readable
//   by the agent's own root shell. Nothing rewrote them and nothing said so.
//
//   THE URL DOOR LET A CONNECTOR POINT AT THE CONTROL PLANE. Loopback was refused; the box's own
//   eth0 address, which answers the same authenticated gateway API, was not, and neither was the
//   docker default gateway, which is the machine's own proxy.
//
//   AND IT COULD BE WALKED AROUND ANYWAY. `[::ffff:127.0.0.1]`, `[::]` and
//   `[::ffff:169.254.169.254]` were all accepted with a secret header, because every rule tested
//   the text of the hostname rather than the address it stands for.
//
//   THE OAUTH REFUSAL WAS UNREACHABLE. It fired only on a literal "auth":"oauth" key in a pasted
//   block, which no vendor writes. The endpoint says so itself in WWW-Authenticate.
//
// Nothing here is anyone's credential: every value is invented and the assertions are about where
// it does NOT go.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".connector-custody-test-"));
const root = mkdtempSync(path.join(tmpdir(), "connector-custody-"));
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
const probe = await bundle("source/host/extensions/mcp/remote-oauth-probe.ts", "remote-oauth-probe.cjs");
const agentTools = await bundle("source/host/runner/tools/sand-mcp-management-tools.ts", "sand-mcp-management-tools.cjs");

const writeConnectors = (servers) =>
  writeFileSync(path.join(root, "connectors.json"), JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
const readConnectors = () => JSON.parse(readFileSync(path.join(root, "connectors.json"), "utf8")).mcpServers;

// The exact entry read out of titanbot-box-wepegxhh3fpvr83bubvz5xm5 on 2026-09-08, argument for
// argument, with the field name it really carries.
const BRIDGED_TINYFISH = {
  command: "npx",
  args: ["-y", "mcp-remote@0.8.3", "https://agent.tinyfish.ai/mcp", "--header", "Authorization:Bearer ${TINYFISH_API_KEY}"],
  env: { MCP_REMOTE_CONFIG_DIR: "/home/box/sand-data/.mcp-auth", TINYFISH_API_KEY: "" },
};

test("a bridged remote entry written before the swap is rewritten to the shape with no argv", () => {
  writeConnectors({
    tinyfish: BRIDGED_TINYFISH,
    slack: { command: "npx", args: ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"], env: { SLACK_MCP_XOXP_TOKEN: "" } },
  });
  const result = connectors.migrateBridgedRemoteEntries(root);
  assert.deepEqual(result.migrated, ["tinyfish"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(readConnectors().tinyfish, {
    type: "http",
    url: "https://agent.tinyfish.ai/mcp",
    headers: { Authorization: "Bearer ${TINYFISH_API_KEY}" },
  });
  // The placeholder is what the store resolves at push time, so the credential is still named and
  // the masked card still knows what to offer.
  assert.deepEqual(connectors.remoteCredentialFieldNames(readConnectors().tinyfish), ["TINYFISH_API_KEY"]);
  // A real stdio server is not a bridge and is not touched.
  assert.equal(readConnectors().slack.command, "npx");
  // And running it again does nothing at all, which is what makes it safe at every host start.
  assert.deepEqual(connectors.migrateBridgedRemoteEntries(root).migrated, []);
});

test("a bridged entry on a private address keeps the reach it already had, and says so", () => {
  // The migration is about where the key lives. An entry written when the door allowed a LAN
  // address has been making those requests for months; refusing it here would leave it on the
  // bridge, still leaking into argv, which is the opposite of the point. A NEW entry at the same
  // address still meets the refusal.
  writeConnectors({ onprem: { command: "npx", args: ["-y", "mcp-remote@0.8.3", "http://10.1.2.3:8080/mcp"] } });
  assert.deepEqual(connectors.migrateBridgedRemoteEntries(root).migrated, ["onprem"]);
  assert.deepEqual(readConnectors().onprem, { type: "http", url: "http://10.1.2.3:8080/mcp", allowPrivateNetwork: true });
  assert.match(
    String(connectors.localConnectorEntryRefusal("onprem2", { type: "http", url: "http://10.1.2.3:8080/mcp" })),
    /inside this box's own network/,
  );
});

test("the bridge's own flags are read, and its own plumbing is dropped with it", () => {
  const sse = connectors.bridgedRemoteEntry({
    command: "npx",
    args: ["-y", "mcp-remote@0.8.5", "https://example.com/sse", "--transport", "sse-only", "--header=X-Api-Key:${ACME_KEY}", "--debug"],
  });
  assert.deepEqual(sse, { type: "sse", url: "https://example.com/sse", headers: { "X-Api-Key": "${ACME_KEY}" } });
  assert.equal(connectors.bridgedRemoteEntry({ command: "npx", args: ["-y", "slack-mcp-server@1.3.0"] }), null);
  assert.equal(connectors.bridgedRemoteEntry({ type: "http", url: "https://example.com/mcp" }), null);
});

test("a bridged entry carrying the key itself is moved into the store, never into the file", () => {
  writeConnectors({
    acme: {
      command: "npx",
      args: ["-y", "mcp-remote@0.8.3", "https://acme.example/mcp", "--header", "Authorization:Bearer sk-live-AAAAAAAAAAAAAAAA"],
    },
  });
  // With nowhere to put the value the entry is LEFT bridged and reported: a migration that copied
  // a key into plaintext connectors.json would be a worse bug than the one it is closing.
  const refused = connectors.migrateBridgedRemoteEntries(root);
  assert.deepEqual(refused.migrated, []);
  assert.match(refused.skipped[0].reason, /carries the key itself/);
  assert.equal(readConnectors().acme.command, "npx");

  const stored = [];
  const moved = connectors.migrateBridgedRemoteEntries(root, {
    storeSecret: (connector, field, value) => { stored.push({ connector, field, value }); return true; },
  });
  assert.deepEqual(moved.migrated, ["acme"]);
  assert.deepEqual(stored, [{ connector: "acme", field: "ACME_TOKEN", value: "sk-live-AAAAAAAAAAAAAAAA" }]);
  assert.deepEqual(readConnectors().acme, {
    type: "http",
    url: "https://acme.example/mcp",
    headers: { Authorization: "Bearer ${ACME_TOKEN}" },
  });
  assert.ok(!readFileSync(path.join(root, "connectors.json"), "utf8").includes("sk-live-"));
});

test("the host refuses its own control plane by address, not only by the word localhost", () => {
  const refused = [
    "http://172.17.0.2:1340/mcp",      // the box's own eth0 on grok-bot-local-vm: the gateway
    "http://192.168.48.6:1340/mcp",    // the demo box's own address on the R750, measured answering
    "http://192.168.32.1:80/",         // the docker default gateway: the machine's own proxy
    "https://192.168.48.7:1337/mcp",   // a neighbour box's exec daemon, https and all
    "http://10.0.0.5/mcp",
    "https://box.internal/mcp",
    "https://100.101.102.103/mcp",     // a tailnet address
  ];
  for (const url of refused) {
    assert.match(String(connectors.localRemoteUrlRefusal(url)), /box itself|inside this box's own network/, url);
    // The agent's own door is the same function, which is the point of it being one function.
    assert.ok(agentTools.validateRemoteMcpUrl(url) != null, `${url} passed the agent's door`);
  }
  assert.equal(connectors.localRemoteUrlRefusal("https://mcp.deepwiki.com/mcp"), null);
  assert.match(String(connectors.localRemoteUrlRefusal("http://mcp.deepwiki.com/mcp")), /plain http/);

  // The one way in, and it has to be said on the entry: an operator holding the box's own gateway
  // token who really does have a server on their LAN. Neither console door nor the agent's tool has
  // a field for it, and loopback stays refused even so, because that address is the control plane
  // itself rather than a machine beside it.
  assert.equal(connectors.localConnectorEntryRefusal("onprem", {
    type: "http", url: "http://10.1.2.3:8080/mcp", allowPrivateNetwork: true,
  }), null);
  assert.match(String(connectors.localConnectorEntryRefusal("onprem", {
    type: "http", url: "http://127.0.0.1:1340/mcp", allowPrivateNetwork: true,
  })), /points back at the box itself/);
});

test("an address written in its IPv6 coat is the same address", () => {
  // Measured through the demo box's own gateway on 2026-09-08: each of these was ACCEPTED with a
  // secret Authorization header while the plain 127.0.0.1 form was refused, because the rule tested
  // the raw hostname and Node hands it `::ffff:7f00:1`, `::` and `::ffff:a9fe:a9fe`.
  for (const url of [
    "https://[::ffff:127.0.0.1]:1341/mcp",
    "https://[::ffff:7f00:1]:1341/mcp",
    "https://[::]:1341/mcp",
    "https://[::1]:1341/mcp",
    "https://[0:0:0:0:0:ffff:7f00:1]:1341/mcp",
    "https://[::ffff:169.254.169.254]/mcp",
    "https://[::ffff:192.168.48.6]:1340/mcp",
    "https://[fe80::1]/mcp",
    "https://[fd12:3456::1]/mcp",
  ]) {
    assert.match(String(connectors.localRemoteUrlRefusal(url)), /box itself|inside this box's own network/, url);
    assert.ok(agentTools.validateRemoteMcpUrl(url) != null, `${url} passed the agent's door`);
  }
  // A global-unicast v6 address is a real server on the internet and stays addable.
  assert.equal(connectors.localRemoteUrlRefusal("https://[2606:4700::1111]/mcp"), null);
});

test("an OAuth-protected endpoint is read off its own answer, and a flaky one refuses nothing", async () => {
  const answer = (status, headers) => async () => ({ status, headers: new Headers(headers) });
  assert.equal(await probe.probeRemoteMcpOAuth("https://mcp.notion.com/mcp", {
    // Measured from this machine on 2026-09-08, verbatim.
    fetch: answer(401, { "www-authenticate": 'Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"' }),
  }), true);
  assert.equal(await probe.probeRemoteMcpOAuth("https://mcp.zapier.com/api/mcp/mcp", {
    fetch: answer(401, { "www-authenticate": 'Bearer realm="Zapier MCP", error="invalid_token"' }),
  }), false, "a plain key challenge is not a browser sign-in");
  assert.equal(await probe.probeRemoteMcpOAuth("https://mcp.deepwiki.com/mcp", { fetch: answer(200, {}) }), false);
  assert.equal(await probe.probeRemoteMcpOAuth("https://nothing.example/mcp", {
    fetch: async () => { throw new Error("ENOTFOUND"); },
  }), null, "a network failure must refuse nothing");
  // The console's door says the same sentence the host's probe does: one wording, two doors.
  const adapterSource = readFileSync(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  assert.ok(adapterSource.includes(probe.OAUTH_REMOTE_REFUSAL), "the console's oauth refusal has drifted from the host's");
});
