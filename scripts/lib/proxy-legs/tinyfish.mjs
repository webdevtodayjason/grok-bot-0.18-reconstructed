/**
 * PROXY-1, the TinyFish leg of `scripts/verify-proxy.mjs`.
 *
 * The claim this leg measures, in one sentence: a box reaches TinyFish through the proxy carrying
 * only its OWN virtual key, the OPERATOR's key is added by the proxy and never enters the box, the
 * call is metered against the calling tenant and nobody else, and revoking that tenant's key takes
 * the route away.
 *
 * It is deliberately runnable two ways.
 *
 *  - As a leg: `import { runTinyFishLeg } from "./tinyfish.mjs"` and call it with the context
 *    verify-proxy builds (below). That is the shape item A's gate consumes; it makes no assumption
 *    about how the proxy was started, only that it is answering and that the master key can mint.
 *  - On its own: `node scripts/lib/proxy-legs/tinyfish.mjs --proxy http://127.0.0.1:4010
 *    --master-key <key> --rest-stub http://127.0.0.1:8791 --operator-key <key>`, which is how it
 *    was measured while it was written, before verify-proxy existed.
 *
 * NOTHING here reads a real credential. The operator key is whatever the harness put in the
 * proxy's own environment, and the two upstreams are stubs: `scripts/lib/mcp-bearer-stub.mjs` for
 * the MCP mount and a small REST recorder for the pass-through. A real TinyFish key never comes
 * near this file, and no key is ever printed -- only its length and the first twelve characters of
 * its sha256.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export const TINYFISH_PROXY_FETCH_PATH = "/tinyfish/fetch";
export const TINYFISH_PROXY_SEARCH_PATH = "/tinyfish/search";
export const TINYFISH_MCP_MOUNT_PATH = "/mcp/";

/** A credential, said out loud safely: how long it is and what it hashes to. Never the value. */
export function fingerprint(value) {
  if (typeof value !== "string" || value.length === 0) return "absent";
  return `${value.length} chars, sha256 ${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function makeRecorder(label) {
  const checks = [];
  return {
    checks,
    ok(name, detail = "") { checks.push({ name, pass: true, detail }); console.log(`PASS ${label} ${name}${detail ? ` -- ${detail}` : ""}`); },
    fail(name, detail = "") { checks.push({ name, pass: false, detail }); console.log(`FAIL ${label} ${name}${detail ? ` -- ${detail}` : ""}`); },
    is(name, actual, expected, detail = "") {
      if (actual === expected) this.ok(name, detail);
      else this.fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ` (${detail})` : ""}`);
    },
  };
}

async function mintKey(proxyUrl, masterKey, body) {
  const response = await fetch(`${proxyUrl}/key/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`key/generate answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function deleteKey(proxyUrl, masterKey, alias) {
  const response = await fetch(`${proxyUrl}/key/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" },
    body: JSON.stringify({ key_aliases: [alias] }),
  });
  return { status: response.status, body: (await response.text()).slice(0, 200) };
}

async function keyInfo(proxyUrl, masterKey, key) {
  const response = await fetch(`${proxyUrl}/key/info?key=${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${masterKey}` },
  });
  if (!response.ok) return null;
  return JSON.parse(await response.text());
}

/** What the REST recorder saw, newest last. The stub answers this on `/__seen`. */
async function seenAt(restStubUrl) {
  const response = await fetch(`${restStubUrl}/__seen`);
  return JSON.parse(await response.text());
}

/**
 * The REST half, both directions: the box's own key goes out, the operator's key comes back in,
 * and the box's key is on nothing the upstream ever saw.
 */
async function measureRestLeg({ proxyUrl, restStubUrl, virtualKey, operatorKey, record }) {
  const before = (await seenAt(restStubUrl)).length;

  const fetchStarted = Date.now();
  const fetched = await fetch(`${proxyUrl}${TINYFISH_PROXY_FETCH_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${virtualKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ urls: ["https://stub.example/"], format: "markdown" }),
  });
  const fetchBody = await fetched.text();
  const fetchMs = Date.now() - fetchStarted;
  record.is("pass-through fetch answers 200", fetched.status, 200, `${fetchMs} ms; body ${fetchBody.slice(0, 60)}`);

  const searchStarted = Date.now();
  const searched = await fetch(`${proxyUrl}${TINYFISH_PROXY_SEARCH_PATH}?query=${encodeURIComponent("bank holidays")}`, {
    headers: { authorization: `Bearer ${virtualKey}`, accept: "application/json" },
  });
  const searchBody = await searched.text();
  const searchMs = Date.now() - searchStarted;
  record.is("pass-through search answers 200", searched.status, 200, `${searchMs} ms; body ${searchBody.slice(0, 60)}`);

  const seen = (await seenAt(restStubUrl)).slice(before);
  record.is("the upstream saw both calls", seen.length, 2);
  for (const call of seen) {
    const headers = call.headers ?? {};
    const sentKey = headers["x-api-key"] ?? null;
    record.is(`${call.path}: the upstream got the OPERATOR key in x-api-key`, sentKey, operatorKey,
      `saw ${fingerprint(sentKey ?? "")}`);
    const whole = JSON.stringify(call);
    record.is(`${call.path}: the box's own key reached nothing upstream`, whole.includes(virtualKey), false);
  }
  const searchCall = seen.find((call) => call.path.endsWith("/search"));
  record.is("the search query survived the hop", (searchCall?.query ?? "").includes("query=bank"), true, searchCall?.query ?? "");

  return { fetchMs, searchMs };
}

/**
 * The MCP half. `mcp-remote` is what a box actually spawns, so this drives the real bridge rather
 * than a hand-rolled client: if the mount does not carry mcp-remote unchanged, leg one is dead and
 * the pass-through is the only route, which is the decision item 4 of the wave asks for.
 */
async function measureMcpLeg({ proxyUrl, virtualKey, timeoutMs = 90_000, record }) {
  const url = new URL(TINYFISH_MCP_MOUNT_PATH, proxyUrl).toString();
  const started = Date.now();
  const child = spawn("npx", [
    "-y", "mcp-remote", url,
    "--transport", "http-only",
    "--header", `x-litellm-api-key:Bearer ${virtualKey}`,
    "--header", "x-mcp-servers:tinyfish",
  ], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });

  // mcp-remote speaks stdio to us and streamable HTTP to the proxy. Initialize, then list.
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "verify-proxy", version: "0" } } });

  const finished = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ reason: "timeout" }), timeoutMs);
    const check = () => {
      if (/"serverInfo"/.test(out) && !check.listed) {
        check.listed = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      }
      if (/"id":2/.test(out)) { clearTimeout(timer); resolve({ reason: "listed" }); }
    };
    child.stdout.on("data", check);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ reason: `exit ${code}` }); });
  });
  const ms = Date.now() - started;
  child.kill("SIGKILL");

  let tools = [];
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const message = JSON.parse(line);
      if (message.id === 2 && message.result?.tools != null) tools = message.result.tools.map((tool) => tool.name);
    } catch { /* mcp-remote also prints prose on stdout; a line that is not JSON is not an answer */ }
  }
  // A NON-EMPTY list, not a 200. The failure shape this mount actually has is a success code with
  // nothing in it, which "it connected" would never catch.
  if (finished.reason === "listed" && tools.length > 0) {
    record.ok("mcp-remote lists tools through the proxy's MCP mount", `${tools.length} tools in ${ms} ms: ${tools.join(", ")}`);
  } else {
    record.fail("mcp-remote lists tools through the proxy's MCP mount",
      `${finished.reason} after ${ms} ms with ${tools.length} tools; stderr ${err.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  // Whatever happened, the box's key must not be in what the bridge printed.
  record.is("mcp-remote printed no credential", `${out}${err}`.includes(virtualKey), false);
  return { ms, tools, reason: finished.reason, stderr: err };
}

/**
 * The whole leg. `context` is what verify-proxy hands every leg:
 *   { proxyUrl, masterKey, restStubUrl, operatorKey, skipMcp?, batchWindowSeconds? }
 * and the return is `{ checks, measurements }` with one entry per assertion, so the gate can
 * summarise PASS/FAIL itself and print the numbers beside them.
 */
export async function runTinyFishLeg(context) {
  const {
    proxyUrl,
    masterKey,
    restStubUrl,
    operatorKey,
    skipMcp = false,
    batchWindowSeconds = 12,
  } = context;
  const record = makeRecorder("tinyfish");
  const measurements = {};
  const stamp = Math.random().toString(36).slice(2, 8);
  const mine = `titanbot-legdemo-${stamp}`;
  const other = `titanbot-legother-${stamp}`;

  // Two things in this body are measurements rather than taste (this Mac, LiteLLM v1.100.0,
  // 2026-09-08). `object_permission` is REQUIRED or the key sees an empty MCP tool list with HTTP
  // 200 and no error at all -- `allowed_mcp_servers` is accepted and then ignored. And `tags` is
  // absent because it is an enterprise feature: a mint carrying one answers 403. The tenant is
  // carried in the alias and the metadata, which is where the spend panel reads it from anyway.
  const mintBody = (alias, slug) => ({
    key_alias: alias,
    models: ["plan-stub"],
    metadata: { slug },
    rpm_limit: 120,
    soft_budget: 5,
    object_permission: { mcp_servers: ["tinyfish"] },
  });
  const minted = await mintKey(proxyUrl, masterKey, mintBody(mine, `legdemo-${stamp}`));
  const neighbour = await mintKey(proxyUrl, masterKey, mintBody(other, `legother-${stamp}`));
  record.ok("two tenant keys minted", `${mine} ${fingerprint(minted.key)}; ${other} ${fingerprint(neighbour.key)}`);
  record.is("the two tenants got different credentials", minted.key === neighbour.key, false);

  try {
    measurements.rest = await measureRestLeg({ proxyUrl, restStubUrl, virtualKey: minted.key, operatorKey, record });

    if (!skipMcp) {
      measurements.mcp = await measureMcpLeg({ proxyUrl, virtualKey: minted.key, record });
    }

    // Metering. Spend is written in batches, so this waits and says which window it waited for
    // rather than reading immediately and calling a zero a result.
    await new Promise((resolve) => setTimeout(resolve, batchWindowSeconds * 1000));
    const mineInfo = await keyInfo(proxyUrl, masterKey, minted.key);
    const otherInfo = await keyInfo(proxyUrl, masterKey, neighbour.key);
    const mineSpend = Number(mineInfo?.info?.spend ?? 0);
    const otherSpend = Number(otherInfo?.info?.spend ?? 0);
    measurements.spend = { mineSpend, otherSpend, waitedSeconds: batchWindowSeconds };
    if (mineSpend > 0) record.ok("the calling tenant was metered", `spend ${mineSpend} after waiting ${batchWindowSeconds} s for the batch window`);
    else record.fail("the calling tenant was metered", `spend still 0 after waiting ${batchWindowSeconds} s for the batch window`);
    record.is("the other tenant was not", otherSpend, 0);

    // Revocation, measured as the PROXY refusing the key -- never as something upstream having
    // stopped serving it.
    const removed = await deleteKey(proxyUrl, masterKey, mine);
    record.is("key/delete accepted the alias", removed.status, 200, removed.body);
    const revokeStarted = Date.now();
    let refusedAfterMs = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = await fetch(`${proxyUrl}${TINYFISH_PROXY_SEARCH_PATH}?query=after-revocation`, {
        headers: { authorization: `Bearer ${minted.key}`, accept: "application/json" },
      });
      await probe.text();
      if (probe.status === 401 || probe.status === 403) { refusedAfterMs = Date.now() - revokeStarted; break; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    measurements.revocationMs = refusedAfterMs;
    if (refusedAfterMs != null) record.ok("a revoked key is refused by the proxy", `${(refusedAfterMs / 1000).toFixed(1)} s after the delete`);
    else record.fail("a revoked key is refused by the proxy", "still served after 80 s");
  } finally {
    await deleteKey(proxyUrl, masterKey, mine);
    await deleteKey(proxyUrl, masterKey, other);
  }

  const failures = record.checks.filter((check) => !check.pass).length;
  console.log(`tinyfish leg: ${record.checks.length - failures} PASS / ${failures} FAIL`);
  return { checks: record.checks, measurements };
}

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] != null && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const context = {
    proxyUrl: argOf("proxy", "http://127.0.0.1:4010"),
    masterKey: argOf("master-key"),
    restStubUrl: argOf("rest-stub", "http://127.0.0.1:8791"),
    operatorKey: argOf("operator-key"),
    skipMcp: process.argv.includes("--no-mcp"),
    batchWindowSeconds: Number(argOf("batch-window", "12")),
  };
  if (context.masterKey == null || context.operatorKey == null) {
    console.error("usage: node scripts/lib/proxy-legs/tinyfish.mjs --master-key <key> --operator-key <key> [--proxy URL] [--rest-stub URL] [--no-mcp]");
    process.exit(2);
  }
  const { checks } = await runTinyFishLeg(context);
  process.exit(checks.some((check) => !check.pass) ? 1 : 0);
}
