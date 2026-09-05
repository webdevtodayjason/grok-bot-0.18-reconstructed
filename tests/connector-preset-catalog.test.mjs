// The connectors wave, console half: the preset catalog in ui/machine-room/gateway-adapter.js and
// the primary-source reports it is drawn from.
//
// The reports under docs/connectors/ are the research: each has a section "## 2 The entry" whose
// fenced json block is the connectors.json entry for that service, chosen and justified there. The
// catalog is that same JSON, typed once more into a file a browser can load. Two copies of one
// fact drift -- a pinned version bumped in the report, a header dropped from the entry -- and the
// console then offers an entry nobody researched. So this file parses the reports and holds the
// catalog against them, key for key, argument for argument. A report change with no catalog change
// fails here, and so does the reverse.
//
// CodeRabbit is in that directory and deliberately NOT in the catalog: its report's section 2 says
// "Do not add CodeRabbit to connectors.json" and carries no json block, because the chosen
// integration is a CLI rather than an MCP server. That absence is asserted too, or the next person
// reading five reports and four presets has to work out which way the mismatch runs.
//
// Nothing here touches a real credential: an entry is a shape, its env values are the empty string
// by contract (CONNECT-4), and the hints say where a key is made, never what one is.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The reports, and the connector each one is the source for. The key is the preset id; a report
// with no entry to spawn maps to null.
const REPORTS = { github: "github", slack: "slack", linear: "linear", google: "google", coderabbit: null };

// Section 2 of a report, and the first fenced json block inside it. Deliberately literal: this has
// to fail loudly if a report is restructured, rather than quietly finding some other block.
async function entryFromReport(name) {
  const text = await readFile(path.join(repoRoot, "docs/connectors", `${name}.md`), "utf8");
  const start = text.indexOf("## 2 The entry");
  assert.notEqual(start, -1, `docs/connectors/${name}.md has no "## 2 The entry" section`);
  const section = text.slice(start, text.indexOf("\n## ", start + 1));
  const fence = section.match(/```json\n([\s\S]*?)```/);
  if (!fence) return null;
  return JSON.parse(fence[1]);
}

// The same harness tests/connector-tinyfish-preset.test.mjs uses: the adapter's IIFE is run with a
// stub window, and the catalog is read off that window exactly as the gate reads it off a real one.
async function loadCatalog() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    open: () => {},
  };
  const fetchStub = async () => ({ ok: true, text: async () => "{}", json: async () => ({}) });
  const fn = new Function("window", "fetch", `${body}\nreturn window.__connectorPresets;`);
  return fn(window, fetchStub);
}

// The card builder, with the host answering and connectors.json holding one entry. Same harness,
// reached through window.__test the way tests/machine-room-connectors.test.mjs does.
async function loadConnectorPlugins(connectors, answers) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { connectorPlugins };\n  global.__bootMachineRoom =",
  );
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    open: () => {},
  };
  const fetchStub = async (url) => {
    const target = String(url);
    if (target === "/connectors") return { ok: true, json: async () => connectors, text: async () => JSON.stringify(connectors) };
    if (!target.startsWith("/api/")) return { ok: true, text: async () => "{}", json: async () => ({}) };
    return { ok: true, text: async () => JSON.stringify(answers[target.slice(5)] ?? {}) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return fn(window, fetchStub).connectorPlugins();
}

// -- The catalog itself: what it holds, in what order, and that every entry is well formed.
test("the connector editor offers the five presets the operator configures, in order", async () => {
  const catalog = await loadCatalog();
  assert.ok(Array.isArray(catalog), "gateway-adapter.js exports no preset catalog");
  assert.deepEqual(catalog.map((p) => p.id), ["tinyfish", "github", "slack", "linear", "google"]);
  for (const preset of catalog) {
    assert.equal(typeof preset.label, "string", `${preset.id} has no label`);
    assert.ok(preset.label.length > 0, `${preset.id} has an empty label`);
    assert.equal(typeof preset.name, "string");
    assert.equal(typeof preset.entry.command, "string");
    assert.ok(Array.isArray(preset.entry.args));
    // CONNECT-4: every env key a preset declares is a credential field, so every one is empty.
    // A key with a value would be configuration and the card would rightly refuse to offer it.
    for (const [name, value] of Object.entries(preset.entry.env)) {
      assert.equal(value, "", `${preset.id} declares ${name} with a value; a credential slot is the empty string`);
    }
  }
});

// -- The catalog against the research. This is the assertion the file exists for.
test("every preset entry is the JSON its report fixes, and CodeRabbit has no entry at all", async () => {
  const catalog = await loadCatalog();
  const byId = new Map(catalog.map((p) => [p.id, p]));
  for (const [report, presetId] of Object.entries(REPORTS)) {
    const entry = await entryFromReport(report);
    if (presetId == null) {
      // CodeRabbit: a CLI, not a server. No json block in section 2, and nothing in the catalog.
      assert.equal(entry, null, `docs/connectors/${report}.md now carries an entry; the catalog needs one too`);
      assert.equal(byId.has(report), false, `${report} is in the catalog but its report defines no connectors.json entry`);
      continue;
    }
    const preset = byId.get(presetId);
    assert.ok(preset, `no ${presetId} preset for docs/connectors/${report}.md`);
    assert.ok(entry, `docs/connectors/${report}.md has no json entry under "## 2 The entry"`);
    assert.deepEqual(preset.entry, entry, `the ${presetId} preset and docs/connectors/${report}.md disagree about the entry`);
  }
});

// -- The hints. One line per credential field, because the field is a masked box with an
// environment variable's name on it and nothing else says where the value is made.
test("every credential field carries one line saying what it is and where it comes from", async () => {
  const catalog = await loadCatalog();
  for (const preset of catalog) {
    const fields = Object.keys(preset.entry.env);
    assert.deepEqual(Object.keys(preset.hints ?? {}).sort(), [...fields].sort(),
      `${preset.id} hints do not match its credential fields`);
    for (const field of fields) {
      const hint = preset.hints[field];
      assert.equal(typeof hint, "string");
      assert.ok(hint.length > 40, `${preset.id}.${field} has no real hint`);
      assert.equal(hint.includes("\n"), false, `${preset.id}.${field} hint is more than one line`);
    }
  }
  // Google's is the one entry with more than a single field, and all three have to be explained:
  // a client pair and a refresh token are three different things made in three different places.
  const google = catalog.find((p) => p.id === "google");
  assert.deepEqual(Object.keys(google.entry.env), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
  // Slack's field is the user token, not the bot one: an xoxb has no search.messages.
  const slack = catalog.find((p) => p.id === "slack");
  assert.deepEqual(Object.keys(slack.entry.env), ["SLACK_MCP_XOXP_TOKEN"]);
  // GitHub's read-only posture lives in the args, so it is the argument list that has to keep it.
  const github = catalog.find((p) => p.id === "github");
  assert.ok(github.entry.args.includes("X-MCP-Readonly:true"), "the GitHub preset lost its read-only header");
  assert.ok(github.entry.args.includes("X-MCP-Toolsets:repos,issues,pull_requests"), "the GitHub preset lost its toolset header");
});

// -- No preset may carry anything that looks like a credential. The value is always the literal
// ${NAME} placeholder mcp-remote expands from the environment the host merges the store into.
test("no preset carries a value where it should carry a placeholder", async () => {
  const catalog = await loadCatalog();
  for (const preset of catalog) {
    for (const arg of preset.entry.args) {
      const bearer = /Authorization:Bearer (.+)$/.exec(arg);
      if (!bearer) continue;
      assert.match(bearer[1], /^\$\{[A-Z0-9_]+\}$/, `${preset.id} carries something other than a placeholder in its bearer header`);
      // The placeholder names a key the entry actually declares, or nothing expands it.
      assert.ok(Object.keys(preset.entry.env).includes(bearer[1].slice(2, -1)),
        `${preset.id}'s bearer names an environment value the entry does not declare`);
      // No space after the colon: the form mcp-remote asks for from clients that mangle spaces.
      assert.equal(arg.includes("Authorization: "), false);
    }
  }
});

// -- The card an operator reaches after Add connector. The host names the fields; only the catalog
// knows what they mean, and a masked box captioned GITHUB_PERSONAL_ACCESS_TOKEN and nothing else
// is where an operator goes to the service's docs to find out what to make.
test("a connector card carries the hint for each credential its entry declares", async () => {
  const catalog = await loadCatalog();
  const github = catalog.find((p) => p.id === "github");
  const [card] = await loadConnectorPlugins(
    { mcpServers: { github: github.entry } },
    {
      listInstalledMcpServers: [{ id: 7, name: "github", status: "connected", transport: "stdio", toolCount: 0 }],
      listMcpServerTools: [],
      listConnectorSecretFields: { server: "github", serverId: 7, fields: ["GITHUB_PERSONAL_ACCESS_TOKEN"], stored: [] },
    },
  );
  assert.deepEqual(card.secretFields, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  assert.equal(card.secretHints.GITHUB_PERSONAL_ACCESS_TOKEN, github.hints.GITHUB_PERSONAL_ACCESS_TOKEN);
  // A field the catalog has never heard of gets no invented line rather than a vague one.
  const [other] = await loadConnectorPlugins(
    { mcpServers: { localfiles: { command: "npx", args: [], env: { PROBE_TOKEN: "" } } } },
    {
      listInstalledMcpServers: [{ id: 8, name: "localfiles", status: "connected", transport: "stdio", toolCount: 0 }],
      listMcpServerTools: [],
      listConnectorSecretFields: { server: "localfiles", serverId: 8, fields: ["PROBE_TOKEN"], stored: [] },
    },
  );
  assert.deepEqual(other.secretFields, ["PROBE_TOKEN"]);
  assert.deepEqual(other.secretHints, {});
});

// -- The console's own projection, and the two views that read it. The editor draws a button per
// preset and fills the four fields from this; the credential card draws the hint under the input.
test("the adapter hands the editor each preset with its arguments as one quoted line", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  // The projection carries the hints through, or the editor has nothing to show on a click.
  assert.match(source, /hints: \{ \.\.\.\(preset\.hints \?\? \{\}\) \}/);
  // And the card's per-field hints come from the same catalog rather than a second list.
  assert.match(source, /secretHints: credentialHintsFor\(secretFields\)/);

  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  // The credential card shows the hint under the field it belongs to.
  assert.match(app, /data-credential-hint="\$\{escapeHtml\(field\)\}"/);
  // The editor shows them on the click, before there is a card to paste into.
  assert.match(app, /data-connector-preset-hints/);
  const start = app.indexOf("} else if (target.dataset.connectorPreset) {");
  assert.notEqual(start, -1, "app.js has no preset click handler");
  const handler = app.slice(start, app.indexOf("} else if (target.dataset.removeConnector)", start));
  assert.match(handler, /preset\.hints\?\.\[name\]/);
  assert.equal(/addConnector/.test(handler), false, "the preset click must fill the form, not write connectors.json");
});
