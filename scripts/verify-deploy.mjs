#!/usr/bin/env node
// verify-deploy.mjs -- the R750 deploy gate, run FROM THE MAC over the tailnet.
//
// It proves six things in order, because a failure in an earlier one explains every later one:
//   1. shape      both titanbot containers run, and their published ports are where they should
//                 be: the relay on 100.110.83.82 only, the box on 127.0.0.1 only, nothing on 0.0.0.0
//   2. gateway    getHostStatus and listAgents answer 200 through http://100.110.83.82:7787
//   3. login      no credential is turned away, a wrong password is refused, the right one issues
//                 a session, and that session reaches the gateway with no bearer of its own
//   4. writes     a probe agent is created and deleted, and the roster returns to its baseline
//   5. console    the Machine Room loads in real headless Chrome, the operator signs in, and the
//                 roster paints
//   6. lockout    six wrong passwords in a row hit the rate limit
//
// The server's bearer token and the probe password are both read over ssh at test time and held in
// memory only. Neither is written to disk on this Mac and neither is printed.
//
//   node scripts/verify-deploy.mjs
//
// Env: TITANBOT_HOST (ssh destination, default dell-remote), TITANBOT_URL (default
// http://100.110.83.82:7787), TITANBOT_ROOT, TITANBOT_UI_PASSWORD, GROK_BOT_PLAYWRIGHT_DIR,
// GROK_BOT_CHROME.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const HOST = process.env.TITANBOT_HOST ?? "dell-remote";
const ROOT = process.env.TITANBOT_ROOT ?? "/home/sem/titanbot";
const BIND = process.env.TITANBOT_BIND ?? "100.110.83.82";
const PORT = process.env.TITANBOT_PORT ?? "7787";
const URL_BASE = process.env.TITANBOT_URL ?? `http://${BIND}:${PORT}`;
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? "/private/tmp/claude-501/-Users-sem-orca-workspaces-grok-bot-0-18-reconstructed-gb/5d8b03a4-9c9b-4e51-af12-2606d5d99b44/scratchpad/pw";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// BatchMode so a missing key fails fast instead of hanging on a password prompt.
const ssh = (command) => new Promise((resolve, reject) =>
  execFile("ssh", ["-o", "BatchMode=yes", HOST, command], { maxBuffer: 32 << 20 },
    (error, out, err) => (error ? reject(new Error(`ssh: ${String(err || error.message).slice(0, 300)}`)) : resolve(String(out)))));

// deleteAgent records the id in the box's deleted-agents.json and never removes it, so this list
// is the one piece of state a probe run leaves behind for good. Reading it lets the gate assert
// how much it left rather than assume none.
const BOX_CONTAINER = process.env.TITANBOT_BOX ?? "titanbot-box";
const tombstones = async () => {
  const raw = await ssh(
    `docker exec ${BOX_CONTAINER} cat /home/box/sand-data/agents/deleted-agents.json 2>/dev/null || echo '[]'`,
  ).catch(() => "[]");
  try { const value = JSON.parse(raw.trim() || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
};

step(`shape of the install on ${HOST}`);
const running = JSON.parse(await ssh(
  `docker inspect titanbot-box titanbot-relay --format '{{json .State.Running}}' 2>/dev/null | paste -sd, - | sed 's/^/[/;s/$/]/'`,
).catch(() => "[]"));
check(running.length === 2 && running.every((r) => r === true), "titanbot-box and titanbot-relay are both running",
  running.length === 2 ? `${running}` : "one or both containers are missing");

// Port bindings, read as docker's own JSON rather than parsed out of `docker ps` text.
const ports = JSON.parse(await ssh(
  `docker inspect titanbot-relay titanbot-box --format '{{json .NetworkSettings.Ports}}' | paste -sd, - | sed 's/^/[/;s/$/]/'`,
).catch(() => "[{},{}]"));
const [relayPorts, boxPorts] = ports;
const bindingsOf = (map) => Object.entries(map ?? {}).flatMap(([container, list]) =>
  (list ?? []).map((b) => ({ container, host: `${b.HostIp}:${b.HostPort}` })));
const relayBindings = bindingsOf(relayPorts);
const boxBindings = bindingsOf(boxPorts);
check(relayBindings.length === 1 && relayBindings[0].container === "7777/tcp" && relayBindings[0].host === `${BIND}:${PORT}`,
  `the relay publishes exactly 7777 on ${BIND}:${PORT}`, relayBindings.map((b) => `${b.container}->${b.host}`).join(" ") || "nothing published");
check(boxBindings.length > 0 && boxBindings.every((b) => b.host.startsWith("127.0.0.1:")),
  "every box port is bound on the server's loopback only", boxBindings.map((b) => b.host).join(" ") || "nothing published");
const wideOpen = [...relayBindings, ...boxBindings].filter((b) => b.host.startsWith("0.0.0.0:") || b.host.startsWith(":::"));
check(wideOpen.length === 0, "no titanbot port is published on 0.0.0.0", wideOpen.map((b) => b.host).join(" ") || "none");

// The token file is the single source of truth for the gateway bearer. Read it here, hold it in
// memory, and never let it reach this Mac's disk or this script's output.
const TOKEN = JSON.parse(await ssh(`cat ${ROOT}/profile/local-docker-vm.json`)).token ?? "";
check(TOKEN.length === 64 && /^[0-9a-f]+$/.test(TOKEN), "the server's gateway token is 64 hex characters", "value withheld");
const mode = (await ssh(`stat -c %a ${ROOT}/profile/local-docker-vm.json`)).trim();
check(mode === "600", "the token file is 0600 on the server", `mode ${mode}`);

// The relay's login password. It cannot be derived from auth.json, which holds only a scrypt hash,
// so the gate has to be told it. The operator keeps it beside the gateway token at the same mode,
// which adds no capability to that directory: anything that can read the token there already holds
// the full gateway surface, password or not. TITANBOT_UI_PASSWORD overrides for a one-off run.
const PASSWORD = process.env.TITANBOT_UI_PASSWORD
  ?? (await ssh(`cat ${ROOT}/profile/ui-password.probe 2>/dev/null || true`).catch(() => "")).replace(/\r?\n$/, "");
const passwordMode = (await ssh(`stat -c %a ${ROOT}/profile/ui-password.probe 2>/dev/null || echo none`).catch(() => "none")).trim();

step(`gateway through ${URL_BASE}`);
const call = async (method, args = {}, headers = {}) => {
  const res = await fetch(`${URL_BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text };
};

const status = await call("getHostStatus", {}, { authorization: `Bearer ${TOKEN}` });
check(status.status === 200 && typeof status.body?.hostVersion === "string", "getHostStatus returns 200 with a hostVersion",
  status.status === 200 ? `hostVersion ${status.body?.hostVersion}, capabilities ${JSON.stringify(status.body?.capabilities ?? [])}` : `HTTP ${status.status} ${status.text.slice(0, 160)}`);

// This used to be the check that the same call with NO authorization header also returned 200,
// which proved the relay injects the bearer and, in the same breath, that reaching the port was
// the same thing as holding the token. The injection proof moved into the login step below, where
// a session cookie stands in for the header; what belongs here now is the closed door.
const unauth = await call("getHostStatus");
check(unauth.status === 401, "the same call with no credential is refused", `HTTP ${unauth.status}`);

// The console sends itself to /login on a 401 only when this header is on it. Without the marker
// it cannot tell the relay's refusal from the gateway's, and a stale gateway bearer would bounce
// an operator who typed the right password back to the login forever.
const marker = await fetch(`${URL_BASE}/api/getHostStatus`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000),
});
check(marker.status === 401 && marker.headers.get("x-relay-auth") === "required",
  "that refusal is marked as the relay's own, which is the only 401 the console treats as signed out",
  `HTTP ${marker.status}, x-relay-auth ${marker.headers.get("x-relay-auth") ?? "absent"}`);

const listed = await call("listAgents", {}, { authorization: `Bearer ${TOKEN}` });
const roster = Array.isArray(listed.body) ? listed.body : listed.body?.agents ?? [];
check(listed.status === 200 && Array.isArray(roster), "listAgents returns 200 with an array",
  listed.status === 200 ? `${roster.length} agent(s)` : `HTTP ${listed.status} ${listed.text.slice(0, 160)}`);
const baseline = roster.map((a) => a.id).sort();

step("the login in front of the relay");
// redirect:"manual" throughout: a followed 302 hides the very thing under test, which is where the
// relay sends a caller it does not recognise.
const hit = (path, init = {}) => fetch(`${URL_BASE}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
const postForm = (path, fields, headers = {}) => hit(path, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers },
  body: new URLSearchParams(fields).toString(),
});

const authState = await hit("/auth/state").then((r) => r.json()).catch(() => null);
check(authState?.required === true, "the relay reports that a password is configured", JSON.stringify(authState));
check(PASSWORD.length > 0, "this gate has the probe password to test with",
  PASSWORD.length > 0 ? `${PASSWORD.length} characters, from ${process.env.TITANBOT_UI_PASSWORD ? "TITANBOT_UI_PASSWORD" : `${ROOT}/profile/ui-password.probe mode ${passwordMode}`}` : `set TITANBOT_UI_PASSWORD or write ${ROOT}/profile/ui-password.probe`);

const home = await hit("/", { headers: { accept: "text/html" } });
check(home.status === 302 && String(home.headers.get("location") ?? "").startsWith("/login"),
  "an unauthenticated browser asking for / is redirected to /login", `HTTP ${home.status} -> ${home.headers.get("location")}`);

const loginPage = await hit("/login", { headers: { accept: "text/html" } });
const loginHtml = loginPage.status === 200 ? await loginPage.text() : "";
check(loginPage.status === 200 && loginHtml.includes('type="password"') && loginHtml.includes('action="/login"'),
  "the login page renders one password field and posts to /login", `HTTP ${loginPage.status}, ${loginHtml.length} bytes`);

const wrong = await postForm("/login", { password: `${PASSWORD}-not-it`, next: "/" });
check(wrong.status === 401 && wrong.headers.get("set-cookie") == null,
  "a wrong password is refused and issues no cookie", `HTTP ${wrong.status}, set-cookie ${wrong.headers.get("set-cookie") ?? "none"}`);

// /login is the one route an unauthenticated caller may POST to on a published port, so it does
// not buffer whatever it is sent. The next successful login clears the failure this records.
const oversize = await hit("/login", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
  body: `password=${"a".repeat(64 * 1024)}`,
});
check(oversize.status === 413, "a login body too large to be a password is refused, not buffered", `HTTP ${oversize.status}`);

const good = await postForm("/login", { password: PASSWORD, next: "/" });
const setCookie = good.headers.get("set-cookie") ?? "";
const session = /(?:^|,\s*)(gb_session=[^;]+)/.exec(setCookie)?.[1] ?? "";
check(good.status === 302 && good.headers.get("location") === "/" && session.length > 0,
  "the right password lands on / with a session cookie", `HTTP ${good.status} -> ${good.headers.get("location")}`);
check(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Max-Age=43200/.test(setCookie),
  "the session cookie is HttpOnly, SameSite=Strict and lasts 12 hours",
  setCookie.replace(/gb_session=[^;]+/, "gb_session=<withheld>") || "no cookie");

// The injection proof, moved: a session carries no gateway token of its own, so a 200 here can
// only mean the relay added the bearer on the way upstream.
const viaSession = await call("getHostStatus", {}, { cookie: session });
check(viaSession.status === 200 && typeof viaSession.body?.hostVersion === "string",
  "that session reaches the gateway with no authorization header, so the relay is still injecting the bearer",
  viaSession.status === 200 ? `hostVersion ${viaSession.body?.hostVersion}` : `HTTP ${viaSession.status}`);

const loggedOut = await hit("/logout", { method: "POST" });
const cleared = loggedOut.headers.get("set-cookie") ?? "";
check(loggedOut.status === 200 && /gb_session=;?\s*Path/i.test(cleared) && /Max-Age=0/.test(cleared),
  "POST /logout clears the cookie", cleared || "no set-cookie");

step("a probe agent, created and deleted");
const tombstonesBefore = await tombstones();
let probeId = null;
try {
  const made = await call("createAgent", {
    name: `verify-deploy-${Math.random().toString(36).slice(2, 7)}`,
    description: "", origin: "user", isKickstartRequested: false,
  }, { authorization: `Bearer ${TOKEN}` });
  const agent = made.body?.agent ?? made.body;
  probeId = agent?.id ?? null;
  check(made.status === 200 && typeof probeId === "string", "createAgent returns 200 with an id",
    made.status === 200 ? probeId ?? "no id in the response" : `HTTP ${made.status} ${made.text.slice(0, 160)}`);
  if (probeId) {
    const after = await call("listAgents", {}, { authorization: `Bearer ${TOKEN}` });
    const ids = (Array.isArray(after.body) ? after.body : after.body?.agents ?? []).map((a) => a.id);
    // The roster can stay at one entry after the probe is created, so this asserts the probe's id
    // is present rather than that the list grew. The reason is a filter, not a phantom: the default
    // "Grok" agent is a real directory on disk with its own store.db, and buildSummary
    // (source/host/extensions/session/session-summaries.ts) drops any row that has no transcript,
    // no name or description of its own, no durable footprint, and is not the active agent. Once
    // the probe becomes active, the blank default stops matching `isActive` and falls out of the
    // list it was in a moment ago. Deleting the probe makes it active again and it comes back.
    check(ids.includes(probeId), "the probe agent appears in listAgents",
      `${ids.length} listed; a blank non-active default agent is filtered out of the list, so this count can stay flat`);
  }
} finally {
  if (probeId) {
    const gone = await call("deleteAgent", { id: probeId }, { authorization: `Bearer ${TOKEN}` }).catch((e) => ({ status: 0, text: String(e) }));
    check(gone.status === 200, "deleteAgent returns 200", `HTTP ${gone.status}`);
    await sleep(1500);
    const final = await call("listAgents", {}, { authorization: `Bearer ${TOKEN}` });
    const ids = (Array.isArray(final.body) ? final.body : final.body?.agents ?? []).map((a) => a.id).sort();
    check(!ids.includes(probeId), "the probe agent is gone from listAgents");
    // A roster that grew during the run is a bug even when the probe cleaned itself up.
    const strays = ids.filter((id) => !baseline.includes(id) && id !== probeId);
    check(strays.length === 0, "the roster is back to its baseline", strays.length ? `strays: ${strays.join(",")}` : `${ids.length} agent(s)`);
    // The roster is back; the volume is not. deleted-agents.json keeps the probe's id for good, so
    // that file grows by exactly one entry per gate run. Expected residue, asserted rather than
    // ignored, because "grows by one" and "grows by more than one" are different bugs and only a
    // check tells them apart.
    const tombstonesAfter = await tombstones();
    check(tombstonesAfter.length === tombstonesBefore.length + 1 && tombstonesAfter.includes(probeId),
      "deleting the probe left exactly one new tombstone, which is expected permanent residue",
      `deleted-agents.json holds ${tombstonesAfter.length} id(s), was ${tombstonesBefore.length}`);
  }
}

step("the Machine Room in a real browser");
// playwright-core comes from the scratchpad install, never from this repo's dependencies, and it
// drives the real Chrome on this Mac rather than a bundled build.
const require = createRequire(`${PW_DIR}/package.json`);
let browser = null;
try {
  const { chromium } = require("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

  // The console is behind the login now, so the browser check starts where an operator does.
  await page.goto(`${URL_BASE}/`, { waitUntil: "load", timeout: 45_000 });
  check(/\/login/.test(page.url()), "a browser opening / lands on the login page", page.url().replace(URL_BASE, ""));
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("button[type=submit]")]);
  check(new URL(page.url()).pathname === "/", "signing in lands on the console", page.url().replace(URL_BASE, ""));

  // The roster is what the adapter paints from listAgents, so its cards are the honest signal
  // that the page reached the gateway rather than just rendering static markup.
  const until = async (fn, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value != null && value !== false) return value;
      if (Date.now() > deadline) return null;
      await sleep(1000);
    }
  };
  const cards = await until(async () => {
    const n = await page.$$eval(".worker-card[data-context-id]", (els) => els.length);
    return n > 0 ? n : null;
  }, 30_000);
  check(cards != null, "the roster renders agent cards from the live gateway", cards != null ? `${cards} card(s)` : "no .worker-card[data-context-id] after 30 s");
  if (cards != null) {
    const names = await page.$$eval(".worker-card[data-context-id] .worker-name", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
    check(names.length > 0, "the cards carry agent names", names.slice(0, 4).join(", "));
  }
  // Reads "0 / 50 agents" on a fresh install even with a card on screen. Both numbers come from the
  // same directory: gateway countAgents is countAgentsOnDisk, which is
  // `sessionStore.listAgents().length` with NO active-agent id, while the card comes from
  // roster-projection.listAgents(), which passes the announced active id. Without that id the blank
  // default agent fails buildSummary's is-this-a-real-agent test (isActive is `dirName ===
  // activeAgentId`) and is filtered out of the count. Same store, different argument -- so the
  // discrepancy is real and unexplained-by-design, not a synthesized card. Measured on the R750:
  // countAgents 0 twice in a row while listAgents returned agent 96a720b6 with a store.db path.
  const count = await page.evaluate(() => document.querySelector("[data-agent-count]")?.textContent?.trim() ?? "");
  check(/\d+\s*\/\s*50/.test(count), "the roster header shows the host's agent count", count || "empty");

  // A gateway the page cannot reach shows up here long before it shows up as a blank panel.
  const gatewayErrors = pageErrors.filter((t) => /gateway|api\/|fetch|502|401/i.test(t));
  check(gatewayErrors.length === 0, "no console error mentions the gateway", gatewayErrors.slice(0, 2).join(" | ") || "none");
  const apiFailures = failedRequests.filter((t) => /\/api\/|\/events/.test(t));
  check(apiFailures.length === 0, "no /api or /events request failed", apiFailures.slice(0, 3).join(" | ") || "none");
  check(await page.isVisible("#logout-button"), "the console offers a Log out control");
} catch (error) {
  check(false, "the browser check ran", String(error?.message ?? error).slice(0, 200));
} finally {
  await browser?.close().catch(() => {});
}

// Last, deliberately: a pass here leaves this Mac's address locked out of the login for thirty
// seconds, so nothing that needs to sign in may run after it.
step("the lockout after repeated wrong passwords");
const attempts = [];
for (let i = 0; i < 6; i += 1) attempts.push((await postForm("/login", { password: `wrong-${i}` })).status);
check(attempts.slice(0, 5).every((s) => s === 401) && attempts[5] === 429,
  "five wrong passwords are refused and the sixth is rate limited", attempts.join(" "));
// The lockout is not a filter on wrong passwords, it is a stop on the source, so the right one has
// to be refused too or a guesser just alternates.
const duringLockout = await postForm("/login", { password: PASSWORD });
check(duringLockout.status === 429, "the right password is refused too while the lockout holds", `HTTP ${duringLockout.status}`);
check(Number(duringLockout.headers.get("retry-after") ?? 0) > 0 && Number(duringLockout.headers.get("retry-after")) <= 30,
  "the response says how long to wait", `retry-after ${duringLockout.headers.get("retry-after")}s`);
// The bearer is not the login, so the lockout must not reach the gates themselves.
const gateDuringLockout = await call("getHostStatus", {}, { authorization: `Bearer ${TOKEN}` });
check(gateDuringLockout.status === 200, "the gateway bearer still works while a login lockout holds", `HTTP ${gateDuringLockout.status}`);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)  ${URL_BASE}`);
process.exit(failures === 0 ? 0 : 1);
