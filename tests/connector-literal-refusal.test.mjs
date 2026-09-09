// MARKET-6. The guard that stops a key reaching connectors.json, pinned where it can be measured.
//
// This exists because a box gate could not measure it. `verify-connector-plane --model-tool` first
// tried to prove the refusal by asking the model to call AddMcpServer with a real-looking key in an
// Authorization header. Measured on grok-bot-local-vm, 2026-09-08: the model read the tool's own
// description, minted `DEEPWIKI_TOKEN` itself, and called with a placeholder — so the guard never
// fired and the add succeeded. That is the system working. It also means the guard is unreachable
// through a normal turn, and a gate that demands the model produce bad input in order to prove a
// guard goes red on correct behaviour.
//
// So the claim moves here, where the input is ours to choose. Two doors go through the same rule —
// the console's writer (`local-connectors.ts`) and the agent's tool
// (`sand-mcp-management-tools.ts`) — and they are asserted TOGETHER, because the thing that would
// hurt is one of them drifting from the other and nobody noticing until a key is in a file.
//
// Every value below is invented and shaped to look like a real key. Nothing here reads one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".connector-literal-refusal-"));
after(() => { rmSync(stage, { recursive: true, force: true }); });

const bundled = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, name);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const connectors = await bundled("source/host/extensions/mcp/local-connectors.ts", "local-connectors.cjs");
const agentTools = await bundled("source/host/runner/tools/sand-mcp-management-tools.ts", "sand-mcp-management-tools.cjs");

const KEY = "sk-live-not-a-real-key-92f4";

test("a key in an Authorization header is refused at both doors", () => {
  const entryRefusal = connectors.remoteHeaderRefusal({ Authorization: `Bearer ${KEY}` });
  assert.notEqual(entryRefusal, null, "the console's writer accepted a key in a header");
  assert.match(String(entryRefusal), /masked box/);

  const agentRefusal = agentTools.credentialLiteralRefusal("acme", { Authorization: `Bearer ${KEY}` }, []);
  assert.notEqual(agentRefusal, null, "the agent's tool accepted a key in a header");
  // The model reads this string and has to know what to write instead, so it must name a field.
  assert.match(String(agentRefusal), /\$\{[A-Z0-9_]+\}/);
  assert.match(String(agentRefusal), /masked box/);
});

test("neither refusal repeats the key back", () => {
  // The refusal is read by the model and lands in the transcript, so a refusal that quotes the
  // value has put it back exactly where refusing it was supposed to keep it out of.
  for (const said of [
    connectors.remoteHeaderRefusal({ Authorization: `Bearer ${KEY}` }),
    agentTools.credentialLiteralRefusal("acme", { Authorization: `Bearer ${KEY}` }, []),
    agentTools.credentialLiteralRefusal("acme", undefined, [`ACME_TOKEN=${KEY}`]),
  ]) {
    assert.equal(String(said).includes(KEY), false, `a refusal carried the key: ${String(said).slice(0, 160)}`);
  }
});

test("a placeholder is what both doors are asking for, so both let it through", () => {
  assert.equal(connectors.remoteHeaderRefusal({ Authorization: "Bearer ${ACME_TOKEN}" }), null);
  assert.equal(agentTools.credentialLiteralRefusal("acme", { Authorization: "Bearer ${ACME_TOKEN}" }, []), null);
  // The shape the model actually produced on the box: it minted the name itself and called with it.
  assert.equal(agentTools.credentialLiteralRefusal("deepwiki", { Authorization: "Bearer ${DEEPWIKI_TOKEN}" }, []), null);
  // An env NAME with no value is how this box marks "the operator still owes a key".
  assert.equal(agentTools.credentialLiteralRefusal("acme", undefined, ["ACME_TOKEN"]), null);
});

test("an env entry carrying its value is refused and told to send the name", () => {
  const said = agentTools.credentialLiteralRefusal("acme", undefined, [`ACME_TOKEN=${KEY}`]);
  assert.notEqual(said, null);
  assert.match(String(said), /only the NAME/);
  assert.match(String(said), /ACME_TOKEN/);
});

test("a header that is configuration stays addable, because refusing it costs a real server", () => {
  // GitHub's preset carries three of these and they decide which tools the operator gets. A door
  // that refused on any unfamiliar header name would make a documented server unaddable for nothing.
  const configuration = { "X-MCP-Readonly": "true", "X-MCP-Toolsets": "repos,issues,pull_requests" };
  assert.equal(connectors.remoteHeaderRefusal(configuration), null);
  assert.equal(agentTools.credentialLiteralRefusal("github", configuration, []), null);
});

test("the two doors answer the same way about the same header, so neither can drift alone", () => {
  // They are separate regexes in separate files today. This is the assertion that fails when one of
  // them is broadened and the other is not — which is the failure that puts a key in a file.
  for (const header of ["Authorization", "authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "api-key", "X-Auth-Token", "X-Access-Token", "X-Figma-Token", "X-Acme-Secret", "Accept", "X-MCP-Toolsets", "User-Agent"]) {
    const entry = connectors.remoteHeaderRefusal({ [header]: KEY }) != null;
    const agent = agentTools.credentialLiteralRefusal("acme", { [header]: KEY }, []) != null;
    assert.equal(entry, agent, `the two doors disagree about "${header}": writer ${entry ? "refuses" : "allows"}, agent ${agent ? "refuses" : "allows"}`);
  }
});
