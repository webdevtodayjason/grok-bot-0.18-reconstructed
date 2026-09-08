#!/usr/bin/env node
// PROXY-1, the LIVE BOX leg: the included set against a box that is actually running, and a real
// browser clicking Settings.
//
//   node scripts/lib/proxy-legs/box-live.mjs
//
// The headless half of this wave is scripts/lib/proxy-legs/box.mjs, which needs no box at all. This
// one needs grok-bot-local-vm up on this Mac and playwright installed (scripts/setup-gates.sh),
// because two of the claims in item C cannot be measured without both: that a real container's
// host reads the file the console writes and reaches the proxy with the tenant's virtual key, and
// that a person can click the thing. A passing page.click is not evidence a human can click, so
// every browser assertion below reads what the page says AFTER the click rather than that the
// click resolved.
//
// It stands a relay copy up that treats the LOCAL BOX as a customer's box, with an included set
// pointing at a stub proxy on this Mac that the container can reach, then:
//
//   console   GET /endpoints lists the plan rows with no key, and POST /endpoints/use writes the
//             six names into the live box at 0600;
//   turn      one REAL turn through the box's own host, which reaches the stub proxy carrying the
//             tenant's virtual key and nothing else, and whose system prompt names the plan;
//   spent     a second real turn while the proxy answers a spent budget;
//   browser   a real Chromium click on Settings: the Included group renders, "Use this one"
//             switches the box, and the Currently answering row moves.
//
// The box's ORIGINAL box-secrets.json is snapshotted first and restored at the end, whatever
// happens. Nothing here writes into .cache/patched-host, which the box bind-mounts from the shared
// workspace: the host bundle is somebody else's leg and moving it under another builder's gate is
// exactly the shared-state stomp the rules forbid.
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
// The box's own gateway token lives in the profile directory the desktop app writes, the same
// resolution scripts/verify-local-turn.mjs uses.
const PROFILE = (process.env.SAND_PROFILE_DIRS ?? "").split(":").find((dir) => dir.length > 0)
  ?? "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data";
const sha12 = (v) => createHash("sha256").update(String(v), "utf8").digest("hex").slice(0, 12);
const tenantKey = (master, slug) => createHmac("sha256", master).update(`titanbot-tenant-session-v1:${slug}`, "utf8").digest("hex");

let failures = 0, checks = 0;
const check = (ok, label, detail = "") => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`); };
const step = (title) => console.log(`\n== ${title}`);
const note = (line) => console.log(`  NOTE  ${line}`);

// ---- the box's own gateway, on the Mac ---------------------------------------------------------
const GATEWAY = "http://127.0.0.1:1340";
const GATEWAY_TOKEN = JSON.parse(readFileSync(path.join(PROFILE, "local-docker-vm.json"), "utf8")).token;
const gw = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST", headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};

// ---- the box's original endpoint pin, kept and put back ----------------------------------------
const SNAPSHOT = execFileSync("docker", ["exec", BOX, "cat", "/home/box/sand-data/box-secrets.json"], { encoding: "utf8" });
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  const file = path.join(tmpdir(), `restore-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(file, SNAPSHOT);
  execFileSync("docker", ["cp", file, `${BOX}:/home/box/sand-data/box-secrets.json`]);
  rmSync(file, { force: true });
  console.log("\n  the box's original endpoint pin is back");
}
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

// ---- a stub proxy the container can reach ------------------------------------------------------
const VIRTUAL_KEY = `sk-${randomBytes(20).toString("hex")}`;
let mode = "ok";
const seen = [];
const proxy = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    seen.push({ url: req.url, keyHash: presented ? sha12(presented) : "", body });
    if (presented !== VIRTUAL_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Authentication Error, invalid proxy server token passed" } }));
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "plan-zai" }, { id: "plan-minimax" }] }));
    }
    if (mode === "spent") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Budget has been exceeded! Current cost: 12.4, Max budget: 10.0", type: "budget_exceeded" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of [
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "SendMessage", arguments: '{"type":"text","content":"Answering through the plan."}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => proxy.listen(0, "0.0.0.0", resolve));
const PROXY_PORT = proxy.address().port;
const PROXY_FOR_BOX = `http://host.docker.internal:${PROXY_PORT}/v1`;

// ---- a relay copy that serves the local box as a CUSTOMER ---------------------------------------
const MASTER = randomBytes(32).toString("hex");
const RELAY_TOKEN = randomBytes(32).toString("hex");
const PASSWORD = randomBytes(18).toString("base64url");
const SLUG = "localplan";
const work = mkdtempSync(path.join(tmpdir(), "local-plan-gate-"));
const stateDir = path.join(work, "state");
const profileDir = path.join(work, "profile");
const relayDir = path.join(work, "relay");
mkdirSync(stateDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(relayDir, { recursive: true });
for (const file of readdirSync(path.join(repoRoot, "ui")).filter((f) => f.endsWith(".mjs"))) {
  copyFileSync(path.join(repoRoot, "ui", file), path.join(relayDir, file));
}
// The console the browser drives is machine-room, which server.mjs serves from beside itself.
cpSync(path.join(repoRoot, "ui/machine-room"), path.join(relayDir, "machine-room"), { recursive: true, dereference: true, filter: (src) => { try { return !lstatSync(src).isSymbolicLink() || true; } catch { return false; } } });
const { newAuthRecord, writeAuthFile } = await import(path.join(relayDir, "auth.mjs"));
writeAuthFile(path.join(relayDir, "auth.json"), newAuthRecord(PASSWORD));

const INCLUDED = {
  baseUrl: PROXY_FOR_BOX, key: VIRTUAL_KEY, keyId: "key-localplan", enforced: false,
  models: [
    { id: "plan-zai", model: "plan-zai", name: "Z.AI GLM (included with your plan)", contextWindow: 200000, servedBy: "Z.AI" },
    { id: "plan-minimax", model: "plan-minimax", name: "MiniMax M3 (included with your plan)", contextWindow: 1000000, servedBy: "MiniMax" },
  ],
};
const tenantsFile = path.join(work, "tenants.json");
writeFileSync(tenantsFile, JSON.stringify({ tenants: [{
  slug: SLUG, name: SLUG, box: BOX, gateway: GATEWAY, token: GATEWAY_TOKEN,
  sessionKey: tenantKey(MASTER, SLUG), stateDir, profileDir, status: "running", included: INCLUDED,
}] }));

const PORT = 36000 + Math.floor(Math.random() * 4000);
let relayLog = "";
const child = spawn(process.execPath, [path.join(relayDir, "server.mjs")], {
  env: {
    ...process.env,
    SAND_UI_PORT: String(PORT), SAND_UI_BIND_HOST: "127.0.0.1",
    SAND_HOST_GATEWAY_URL: GATEWAY, SAND_HOST_GATEWAY_TOKEN: GATEWAY_TOKEN,
    SAND_BOX_CONTAINER: BOX,
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN, SAND_UI_TENANTS_FILE: tenantsFile,
    SAND_UI_STATE_DIR: "", SAND_UI_AUTH_FILE: "", SAND_UI_ENDPOINTS_FILE: "",
    SAND_PROFILE_DIRS: PROFILE, TITAN_JOB_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (c) => { relayLog += c; });
child.stderr.on("data", (c) => { relayLog += c; });
const up = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 30_000);
  child.stdout.on("data", () => { if (relayLog.includes("cfip ")) { clearTimeout(timer); resolve(true); } });
  child.on("exit", () => { clearTimeout(timer); resolve(false); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const stopAll = () => { try { child.kill("SIGKILL"); } catch {} proxy.close(); try { rmSync(work, { recursive: true, force: true }); } catch {} };

try {
  check(up, "a relay copy serving the local box as a customer is up", `port ${PORT}`);
  if (!up) { console.log(relayLog.slice(-1500)); process.exit(1); }

  const { mintSessionToken } = await import(path.join(relayDir, "session-token.mjs"));
  const now = Date.now();
  const { token } = mintSessionToken({ sub: `acct_${SLUG}`, email: `${SLUG}@titanium.bot`, tenant: SLUG, host: "console.titanium.bot", iat: now, exp: now + 3_600_000, jti: `${SLUG}-${now}` }, tenantKey(MASTER, SLUG), now);
  const signIn = await fetch(`${BASE}/login?sso=${encodeURIComponent(token)}`, { redirect: "manual", headers: { accept: "text/html" } });
  const setCookies = typeof signIn.headers.getSetCookie === "function" ? signIn.headers.getSetCookie() : [signIn.headers.get("set-cookie") ?? ""];
  const cookie = setCookies.map((line) => /(gb_session=[^;]+)/.exec(line)?.[1] ?? "").find((value) => value.length > 0) ?? "";
  check(cookie.length > 0, "the customer signs in", `HTTP ${signIn.status} -> ${signIn.headers.get("location") ?? "(no location)"}`);
  if (cookie.length === 0) { console.log(relayLog.split("\n").slice(-12).join("\n")); }

  step("the console, against the live box");
  const listing = await (await fetch(`${BASE}/endpoints`, { headers: { cookie, accept: "application/json" } })).json();
  check(listing.included?.length === 2, "the plan's two models are listed", `${listing.included?.length ?? 0}`);
  check(!JSON.stringify(listing).includes(VIRTUAL_KEY), "and the virtual key is not in the answer");
  check(listing.included?.every((r) => r.health != null) === true, "every plan row carries one shared health answer");
  // On the R750 the relay and the box reach the proxy by the same name on titanbot-net. On this
  // Mac they cannot: the container reaches the Mac at host.docker.internal, which the Mac itself
  // does not resolve. So the relay's own probe of that address is expected to fail here, and it is
  // reported rather than asserted. The box's real turn below is the reachability measurement.
  note(`the relay's probe of ${PROXY_FOR_BOX} says: ${JSON.stringify(listing.included?.[0]?.health)}`);

  const used = await fetch(`${BASE}/endpoints/use`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: "plan-zai" }) });
  check(used.status === 200, "the live box is pointed at plan-zai through the console", `HTTP ${used.status}`);
  const written = JSON.parse(execFileSync("docker", ["exec", BOX, "cat", "/home/box/sand-data/box-secrets.json"], { encoding: "utf8" })).secrets;
  for (const [name, value] of Object.entries({
    SAND_OPENAI_COMPATIBLE_BASE_URL: PROXY_FOR_BOX, SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai",
    SAND_OPENAI_COMPATIBLE_API_KEY: VIRTUAL_KEY, SAND_OPENAI_COMPATIBLE_SERVED_BY: "Z.AI",
    SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "Z.AI GLM (included with your plan)",
    SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "200000",
  })) check(written[name] === value, `${name} is in the live box`, name.endsWith("API_KEY") ? sha12(written[name] ?? "") : String(written[name]));
  const mode600 = execFileSync("docker", ["exec", BOX, "stat", "-c", "%a %U:%G", "/home/box/sand-data/box-secrets.json"], { encoding: "utf8" }).trim();
  check(mode600.startsWith("600 "), "box-secrets.json is 0600 in the live box", mode600);

  step("one real turn, through the proxy, on the virtual key");
  const agents = await gw("listAgents");
  const agent = (Array.isArray(agents) ? agents : agents?.agents ?? []).find((a) => !a.isGroup) ?? (Array.isArray(agents) ? agents[0] : null);
  check(agent != null, "the box has an agent to answer with", agent?.name ?? "(none)");
  const before = seen.length;
  if (agent != null) {
    await gw("sendPrompt", { agentId: agent.id, prompt: "What do you run on? Reply in one short line." }).catch((error) => note(`sendPrompt: ${error.message.slice(0, 200)}`));
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !seen.slice(before).some((s) => s.url?.includes("chat/completions"))) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const turn = seen.slice(before).find((s) => s.url?.includes("chat/completions"));
  check(turn != null, "the box's host reached the proxy for a turn", turn ? turn.url : "(no chat request arrived)");
  if (turn != null) {
    check(turn.keyHash === sha12(VIRTUAL_KEY), "carrying this tenant's virtual key and nothing else", turn.keyHash);
    let prompt = "";
    try { prompt = JSON.parse(turn.body).messages?.[0]?.content ?? ""; } catch { prompt = turn.body.slice(0, 200); }
    const named = prompt.includes("Z.AI GLM (included with your plan)") && !prompt.includes("host.docker.internal");
    // Not asserted here, and the reason is stated rather than hidden: this container bind-mounts
    // the SHARED workspace's .cache/patched-host, so it runs the shipped bundle, which has no
    // SERVED_BY in it. Moving that bundle is a different item's leg and doing it under another
    // builder's gate is the shared-state stomp the rules forbid. The sentence itself is measured
    // against a real esbuild bundle of provider-session.ts in tests/openai-compatible-provider.
    if (named) check(true, "and a system prompt that names the plan, not the container");
    else note(`the box's prompt still names the base URL host: this container runs the SHIPPED host bundle (no SERVED_BY). The sentence is measured in tests/openai-compatible-provider.test.mjs and reaches a box when the bundle ships.`);
  }

  step("a plan-spent turn");
  mode = "spent";
  const spentBefore = seen.length;
  if (agent != null) {
    await gw("sendPrompt", { agentId: agent.id, prompt: "And again, one short line." }).catch(() => {});
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !seen.slice(spentBefore).some((s) => s.url?.includes("chat/completions"))) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const spent = seen.slice(spentBefore).find((s) => s.url?.includes("chat/completions"));
  check(spent != null, "the box asked again and the proxy refused it as spent", spent ? "400 budget" : "(no chat request arrived)");
  mode = "ok";

  step("a real browser on Settings");
  const { chromium } = createRequire(path.join(repoRoot, ".cache/playwright", "package.json"))("playwright-core");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login?sso=${encodeURIComponent(mintSessionToken({ sub: `acct_${SLUG}`, email: `${SLUG}@titanium.bot`, tenant: SLUG, host: "console.titanium.bot", iat: Date.now(), exp: Date.now() + 3_600_000, jti: `${SLUG}-b-${Date.now()}` }, tenantKey(MASTER, SLUG)).token)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.getByRole("button", { name: /settings/i }).first().click({ timeout: 15_000 });
    await page.waitForSelector('[data-plugin-group="Plan"]', { timeout: 20_000 });
    check(true, "the Included with your plan group renders on Settings");
    const heading = await page.locator('[data-plugin-group="Plan"] h3').first().innerText();
    check(heading.trim() === "Included with your plan", "with the heading a customer reads", heading.trim());
    const cardCount = await page.locator('[data-plugin-group="Plan"] .plugin-nav-button').count();
    check(cardCount === 2, "two cards, one per model in the plan", String(cardCount));
    const inputs = await page.locator('[data-plugin-group="Plan"] input, [data-plugin-group="Plan"] form, [data-plugin-group="Plan"] textarea').count();
    check(inputs === 0, "and no field and no form anywhere in the group", `${inputs} found`);
    check((await page.locator('[data-plugin-group="Providers"] h3').first().innerText()).trim() === "Your own keys", "the providers group is now Your own keys");

    // Open the plan-minimax card and press its switch. A passing page.click is not evidence a human
    // can click, so the assertion is what the CURRENT ENDPOINT ROW says afterwards.
    await page.locator('[data-plugin-group="Plan"] .plugin-nav-button', { hasText: "MiniMax" }).first().click({ timeout: 10_000 });
    const useButton = page.locator('[data-plugin-group="Plan"] button[data-use-endpoint="plan-minimax"]');
    check(await useButton.count() > 0, "the plan card offers one action and no form");
    check((await useButton.first().innerText()).trim() === "Use this one", "labelled Use this one", (await useButton.first().innerText()).trim());
    await useButton.first().click({ timeout: 10_000 });
    await page.waitForFunction(() => (document.querySelector("#endpoint-current")?.textContent ?? "").includes("MiniMax M3 (included with your plan)"), null, { timeout: 30_000 })
      .then(() => check(true, "Currently answering moves to the model that was picked"))
      .catch(async () => check(false, "Currently answering moves to the model that was picked", await page.locator("#endpoint-current").innerText().catch(() => "(no row)")));
    const live = JSON.parse(execFileSync("docker", ["exec", BOX, "cat", "/home/box/sand-data/box-secrets.json"], { encoding: "utf8" })).secrets;
    check(live.SAND_OPENAI_COMPATIBLE_MODEL === "plan-minimax", "and the live box followed the click", String(live.SAND_OPENAI_COMPATIBLE_MODEL));
    check(live.SAND_OPENAI_COMPATIBLE_SERVED_BY === "MiniMax", "with the plan's name for the persona", String(live.SAND_OPENAI_COMPATIBLE_SERVED_BY));
  } finally { await browser.close(); }

  step("nothing was said out loud");
  for (const [secret, what] of [[VIRTUAL_KEY, "the virtual key"], [GATEWAY_TOKEN, "the box's gateway token"], [RELAY_TOKEN, "the relay credential"], [PASSWORD, "the instance password"]]) {
    check(!relayLog.includes(secret), `${what} is nowhere in the relay's log`);
  }
} finally {
  restore();
  stopAll();
}

console.log("");
console.log(failures === 0 ? `verify-proxy --leg box-live: PASS (${checks} checks)` : `verify-proxy --leg box-live: FAIL (${failures} of ${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
