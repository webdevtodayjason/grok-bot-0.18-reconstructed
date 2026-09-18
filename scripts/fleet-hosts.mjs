#!/usr/bin/env node
// One line per workspace: which host bundle it is on, and whether it answers.
//
// Runs ON the R750, because reaching a box means `docker exec` and nothing publishes the gateway
// port. From the Mac:
//
//   ssh dell-remote 'node --input-type=module' < scripts/fleet-hosts.mjs
//
// The gateway token is read inside the box from its own environment and never appears in an
// argument or in the output, which is also why the status call is a `node -e` in the container
// rather than a curl from here.
import { execFile } from "node:child_process";

const CP = process.env.FLEET_CP ?? "titanbot-cp-hnhzi0ongkw0gsg9k4flcv7d";

const run = (args, timeoutMs = 30_000) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 8 << 20, timeout: timeoutMs }, (error, out) =>
    resolve(error == null ? String(out) : "")));

/** slug -> container, from the control plane's own record rather than from container names. */
async function workspaces() {
  const out = await run(["exec", CP, "node", "-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.CP_DATA_DIR + "/control-plane.sqlite", { readOnly: true });
    const rows = db.prepare("select slug, box_container from tenants order by slug").all();
    process.stdout.write(JSON.stringify(rows.filter((r) => r.box_container)));
  `]);
  const at = out.indexOf("[");
  if (at === -1) return [];
  try { return JSON.parse(out.slice(at, out.lastIndexOf("]") + 1)); } catch { return []; }
}

/** One box. A box that cannot answer is said to be unreachable, never assumed to be fine. */
async function hostOf(container) {
  const out = await run(["exec", container, "/exec-daemon/node", "-e", `
    const h = { authorization: "Bearer " + process.env.SAND_GATEWAY_TOKEN, "content-type": "application/json" };
    fetch("http://127.0.0.1:1340/api/getHostStatus", { method: "POST", headers: h, body: "{}" })
      .then((r) => r.json())
      .then((s) => process.stdout.write(JSON.stringify({ version: s.hostVersion, busy: s.isBusy === true, latest: s.latestHostVersion })))
      .catch(() => process.stdout.write("{}"));
  `]);
  const at = out.indexOf("{");
  if (at === -1) return null;
  try { return JSON.parse(out.slice(at, out.lastIndexOf("}") + 1)); } catch { return null; }
}

const rows = await workspaces();
if (rows.length === 0) {
  console.log("no workspaces on record; is the control plane container named something else? set FLEET_CP");
  process.exit(1);
}

const pad = (value, width) => String(value ?? "").padEnd(width);
console.log(`${pad("workspace", 16)}${pad("box", 26)}${pad("host", 14)}health`);
const seen = new Map();
for (const row of rows) {
  const status = await hostOf(row.box_container);
  const version = status?.version ?? "";
  const health = status == null || version.length === 0
    ? "unreachable"
    : status.busy ? "busy" : "ok";
  if (version.length > 0) seen.set(version, (seen.get(version) ?? 0) + 1);
  console.log(`${pad(row.slug, 16)}${pad(String(row.box_container).replace(/^titanbot-box-/, ""), 26)}${pad(version || "-", 14)}${health}`);
}

// The question this is polled to answer, answered rather than left to the reader.
const versions = [...seen.entries()].sort((a, b) => b[1] - a[1]);
console.log("");
if (versions.length === 1) console.log(`all ${versions[0][1]} reachable box(es) on ${versions[0][0]}`);
else console.log(`${versions.length} bundles in the fleet: ${versions.map(([v, n]) => `${v} on ${n}`).join(", ")}`);
