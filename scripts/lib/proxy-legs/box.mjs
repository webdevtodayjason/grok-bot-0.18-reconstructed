#!/usr/bin/env node
// PROXY-1, the BOX leg of scripts/verify-proxy.mjs.
//
// Scope, stated so nobody reads more into a PASS than is here. This leg measures everything the
// relay and a box can be held to on one machine with no network, no docker and no control plane:
//
//   reaches      a tenant's virtual key gets a model list through the proxy, and the plan rows the
//                console lists carry the word "included" where a key would be;
//   refused      a request carrying the OPERATOR's own key is refused BY THE PROXY, and the relay
//                never sends it -- the proxy in this leg only accepts that tenant's virtual key;
//   written      pointing a box at a plan model writes the six names into box-secrets.json, at
//                0600, and leaves the other credential plane in that file alone;
//   gone         forget-provider-keys takes the copied operator key back out of all three places
//                by hash, and answers with names, lengths and hash prefixes and nothing else;
//   unchanged    the tenant guard still refuses an address inside this server's network, a plan
//                row never reaches endpoints.json, and a save with plan rows on screen succeeds.
//
// What this leg does NOT measure, because it cannot on this Mac: spend landing per tenant,
// revocation timing against a real cache TTL, and the two-key pool failing over. Those are the
// proxy's own legs and then the R750. The sentence a customer reads on a refusal is a host-bundle
// fact and is measured by tests/openai-compatible-provider.test.mjs.
//
// Runs on its own -- `node scripts/lib/proxy-legs/box.mjs` -- or from verify-proxy.mjs, which
// passes its own check/skip/step so one run reports as one gate.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startLinkClaimCp } from "../link-claim-cp.mjs";

export const name = "box";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const tenantKey = (master, slug) => createHmac("sha256", master).update(`titanbot-tenant-session-v1:${slug}`, "utf8").digest("hex");
const sha12 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);

// The same docker the relay tests use: a program on PATH that reaches a directory instead of a
// container, and runs the shell command it is handed for real. That last part is what makes the
// file MODE below a mode a shell produced rather than one a mock agreed to report.
const DOCKER_STUB = `#!/bin/sh
root="$FAKE_BOX_ROOT"
case "$1" in
  version) echo 27.0.0 ; exit 0 ;;
  ps) cat "$root/names" ; exit 0 ;;
  inspect) exit 0 ;;
  exec) ;;
  *) exit 1 ;;
esac
shift
if [ "$1" = "-i" ]; then shift; fi
box="$1"
shift
dir="$root/$box"
if [ ! -d "$dir" ]; then exit 1; fi
if [ "$1" = "cat" ]; then
  shift
  exec cat "$(printf '%s' "$1" | sed "s|^/home/box/sand-data|$dir|")"
fi
if [ "$1" = "sh" ] && [ "$2" = "-c" ]; then
  exec /bin/sh -c "$(printf '%s' "$3" | sed "s|/home/box/sand-data|$dir|g")"
fi
exit 1
`;

// A proxy that accepts exactly one credential. Anything else is 401, which is how this leg proves
// the operator's key is refused rather than merely absent.
function startStubProxy(virtualKey) {
  const seen = [];
  const server = createServer((req, res) => {
    const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    seen.push({ url: req.url, keyHash: presented.length > 0 ? sha12(presented) : "" });
    if (presented !== virtualKey) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Authentication Error, invalid proxy server token passed" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "plan-zai" }, { id: "plan-minimax" }, { id: "plan-qwen" }] }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    seen,
    stop: () => new Promise((done) => server.close(done)),
  })));
}

export async function run(reporter = {}) {
  const state = { failures: 0, checks: 0 };
  const check = reporter.check ?? ((ok, label, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  });
  const step = reporter.step ?? ((title) => console.log(`\n== ${title}`));
  const record = (ok, label, detail = "") => { state.checks += 1; if (!ok) state.failures += 1; check(ok, label, detail); };

  const temps = [];
  const stoppers = [];
  const cleanup = () => {
    for (const stop of stoppers.splice(0)) { try { stop(); } catch { /* going away anyway */ } }
    for (const dir of temps.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ditto */ } }
  };

  // Every credential in this run is minted here, lives for one process and is never printed.
  const MASTER = randomBytes(32).toString("hex");
  const RELAY_TOKEN = randomBytes(32).toString("hex");
  const INSTANCE_PASSWORD = randomBytes(18).toString("base64url");
  const VIRTUAL_KEY = `sk-${randomBytes(20).toString("hex")}`;
  const OPERATOR_KEY = `operator-provider-key-${randomBytes(12).toString("hex")}`;
  const OPERATOR_TINYFISH = `operator-tinyfish-key-${randomBytes(12).toString("hex")}`;
  const SLUG = "demo";

  const proxy = await startStubProxy(VIRTUAL_KEY);
  stoppers.push(() => proxy.stop());

  // The box, as a directory, holding exactly what the R750's three boxes hold today: one copied
  // operator provider key in the endpoint pin and the same operator's TinyFish key beside it.
  const boxRoot = mkdtempSync(path.join(tmpdir(), "proxy-leg-boxes-"));
  temps.push(boxRoot);
  const BOX = "titanbot-box-demo";
  const boxDir = path.join(boxRoot, BOX);
  mkdirSync(boxDir, { recursive: true });
  writeFileSync(path.join(boxRoot, "names"), `${BOX}\n`);
  const stubBin = path.join(boxRoot, "bin");
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(path.join(stubBin, "docker"), DOCKER_STUB);
  chmodSync(path.join(stubBin, "docker"), 0o755);
  const boxFile = (name) => path.join(boxDir, name);
  writeFileSync(boxFile("box-secrets.json"), JSON.stringify({ version: 1, secrets: {
    SAND_OPENAI_COMPATIBLE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    SAND_OPENAI_COMPATIBLE_MODEL: "qwen3.8-max",
    SAND_OPENAI_COMPATIBLE_API_KEY: OPERATOR_KEY,
    SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "Qwen",
    CODERABBIT_API_KEY: "a credential of the customer's own",
  } }));
  writeFileSync(boxFile("connector-env-secrets.json"), JSON.stringify({
    servers: { tinyfish: { TINYFISH_API_KEY: OPERATOR_TINYFISH } },
    shell: { CODERABBIT_API_KEY: "a credential of the customer's own" },
  }));

  // The tenant's own directories, and the registry row the control plane would have sent.
  const tenantRoot = mkdtempSync(path.join(tmpdir(), "proxy-leg-tenant-"));
  temps.push(tenantRoot);
  const stateDir = path.join(tenantRoot, "state");
  const profileDir = path.join(tenantRoot, "profile");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const tenantsFile = path.join(tenantRoot, "tenants.json");
  writeFileSync(tenantsFile, JSON.stringify({ tenants: [{
    slug: SLUG, name: SLUG, box: BOX, gateway: "http://127.0.0.1:1",
    token: randomBytes(16).toString("hex"), sessionKey: tenantKey(MASTER, SLUG),
    stateDir, profileDir, status: "running",
    included: {
      baseUrl: proxy.url, key: VIRTUAL_KEY, keyId: "key-demo", enforced: false,
      models: [
        { id: "plan-zai", model: "plan-zai", name: "Z.AI GLM (included with your plan)", contextWindow: 200000, servedBy: "Z.AI" },
        { id: "plan-minimax", model: "plan-minimax", name: "MiniMax M3 (included with your plan)", contextWindow: 1000000, servedBy: "MiniMax" },
      ],
    },
  }] }));

  // A copy of ui/, never ui/ itself: the operator's own auth.json and endpoints.json would
  // otherwise decide which branch runs.
  const relayDir = mkdtempSync(path.join(tmpdir(), "proxy-leg-relay-"));
  temps.push(relayDir);
  for (const file of readdirSync(path.join(repoRoot, "ui")).filter((f) => f.endsWith(".mjs"))) {
    copyFileSync(path.join(repoRoot, "ui", file), path.join(relayDir, file));
  }
  const { newAuthRecord, writeAuthFile } = await import(path.join(relayDir, "auth.mjs"));
  writeAuthFile(path.join(relayDir, "auth.json"), newAuthRecord(INSTANCE_PASSWORD));

  // ONBOARD-5. A sign-in link is checked with the control plane on every click, and a relay that
  // cannot ask refuses the click. This leg signs a customer in by link, so it needs something on the
  // other end of that one call: CP_URL pointed at port 1, which is what this was, is now a console
  // that refuses every link. It answers nothing else, which keeps this leg's "no control plane"
  // scope honest -- the registry still comes out of the override file.
  const linkCp = await startLinkClaimCp({ relayToken: RELAY_TOKEN });
  stoppers.push(() => linkCp.stop());

  let relay = null;
  for (let attempt = 0; attempt < 5 && relay == null; attempt += 1) {
    const port = 35000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(relayDir, "server.mjs")], {
      env: {
        ...process.env,
        PATH: `${stubBin}:/usr/bin:/bin`,
        FAKE_BOX_ROOT: boxRoot,
        SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1", SAND_HOST_GATEWAY_TOKEN: randomBytes(16).toString("hex"),
        CP_URL: linkCp.base, CP_RELAY_TOKEN: RELAY_TOKEN,
        SAND_UI_TENANTS_FILE: tenantsFile,
        SAND_UI_STATE_DIR: "", SAND_UI_AUTH_FILE: "", SAND_UI_ENDPOINTS_FILE: "",
        SAND_PROFILE_DIRS: "", TITAN_JOB_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    const up = await new Promise((resolve) => {
      const done = () => resolve(log.includes("cfip "));
      const timer = setTimeout(done, 25_000);
      child.stdout.on("data", () => { if (log.includes("cfip ")) { clearTimeout(timer); resolve(true); } });
      child.on("exit", () => { clearTimeout(timer); resolve(false); });
    });
    if (up) { relay = { base: `http://127.0.0.1:${port}`, log: () => log, stop: () => child.kill("SIGKILL") }; stoppers.push(() => child.kill("SIGKILL")); }
    else child.kill("SIGKILL");
  }
  if (relay == null) {
    record(false, "the relay copy starts", "it would not listen on any of five ports");
    cleanup();
    return state;
  }

  try {
    // A customer's door: a sign-in link this console verifies with that tenant's own key, minted
    // by the relay's own module rather than by a copy of its rules that can drift from them.
    const { mintSessionToken } = await import(path.join(relayDir, "session-token.mjs"));
    const now = Date.now();
    const { token } = mintSessionToken({
      sub: `acct_${SLUG}`, email: `${SLUG}@titanium.bot`, tenant: SLUG, host: "console.titanium.bot",
      iat: now, exp: now + 3_600_000, jti: `${SLUG}-${now}`,
    }, tenantKey(MASTER, SLUG), now);
    const signIn = await fetch(`${relay.base}/login?sso=${encodeURIComponent(token)}`, { redirect: "manual", headers: { accept: "text/html" } });
    const cookie = /(?:^|,\s*)(gb_session=[^;]+)/.exec(signIn.headers.get("set-cookie") ?? "")?.[1] ?? "";
    record(cookie.length > 0, "a customer signs in to the one console", `HTTP ${signIn.status}`);
    // ONBOARD-5, measured here because this leg already holds a link and a relay: the door asked the
    // control plane once, and the same link a second time is refused rather than minting a second
    // session.
    record(linkCp.claims.length === 1 && linkCp.claims[0].tenant === SLUG,
      "and the console asked the control plane once whether that link was still good",
      `${linkCp.claims.length} claim(s)`);
    const twice = await fetch(`${relay.base}/login?sso=${encodeURIComponent(token)}`, { redirect: "manual", headers: { accept: "text/html" } });
    record(twice.status === 401 && !/gb_session=/.test(twice.headers.get("set-cookie") ?? ""),
      "a second click on the same link signs nobody in", `HTTP ${twice.status}`);
    if (cookie.length === 0) { cleanup(); return state; }

    step("reaches: the plan's rows, and the key that gets them");
    const listing = await (await fetch(`${relay.base}/endpoints`, { headers: { cookie, accept: "application/json" } })).json();
    record(Array.isArray(listing.included) && listing.included.length === 2, "the plan's models are listed", `${listing.included?.length ?? 0} row(s)`);
    record(listing.included.every((row) => row.apiKey === "included"), "with the word \"included\" where a key would be");
    record(!JSON.stringify(listing).includes(VIRTUAL_KEY), "and the virtual key nowhere in the answer");
    record(listing.included.every((row) => row.health?.reachable === true), "every plan row reaches a model list through the proxy");
    record(proxy.seen.length === 1, "three rows are one probe, not three", `${proxy.seen.length} request(s)`);
    record(proxy.seen[0]?.keyHash === sha12(VIRTUAL_KEY), "and the probe carried this tenant's virtual key", proxy.seen[0]?.keyHash ?? "(none)");

    step("refused: the operator's own key, at the proxy");
    const refused = await fetch(`${proxy.url}/models`, { headers: { authorization: `Bearer ${OPERATOR_KEY}` } });
    record(refused.status === 401, "the proxy refuses a request carrying the operator's key", `HTTP ${refused.status}`);
    record(!proxy.seen.some((seen) => seen.keyHash === sha12(OPERATOR_KEY) && seen.url !== "/v1/models"), "and the relay never sent it");

    step("unchanged: the guard, and where a plan row is allowed to live");
    const save = (rows) => fetch(`${relay.base}/endpoints`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ endpoints: rows }),
    });
    const inside = await save([{ id: "probe", name: "probe", baseUrl: "https://192.168.32.1:8000", model: "m", apiKey: "k" }]);
    record(inside.status === 400, "an address inside this server's network is still refused", `HTTP ${inside.status}`);
    const withPlan = await save([...listing.included, { id: "mine", name: "my own provider", baseUrl: "https://93.184.216.34/v1", model: "m", apiKey: OPERATOR_KEY }]);
    const savedBody = await withPlan.json().catch(() => ({}));
    record(withPlan.status === 200 && savedBody.saved === 1, "a save with the plan rows on screen writes only the customer's own", `HTTP ${withPlan.status}`);
    const catalogText = readFileSync(path.join(stateDir, "endpoints.json"), "utf8");
    record(!catalogText.includes("plan-"), "and no plan row reaches endpoints.json");

    step("written: the six names, and the mode");
    const used = await fetch(`${relay.base}/endpoints/use`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: "plan-zai" }),
    });
    record(used.status === 200, "the box is pointed at a plan model", `HTTP ${used.status}`);
    const secrets = JSON.parse(readFileSync(boxFile("box-secrets.json"), "utf8")).secrets;
    const expected = {
      SAND_OPENAI_COMPATIBLE_BASE_URL: proxy.url,
      SAND_OPENAI_COMPATIBLE_API_KEY: VIRTUAL_KEY,
      SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai",
      SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "Z.AI GLM (included with your plan)",
      SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "200000",
      SAND_OPENAI_COMPATIBLE_SERVED_BY: "Z.AI",
    };
    for (const [key, value] of Object.entries(expected)) record(secrets[key] === value, `${key} is written`, key.endsWith("API_KEY") ? sha12(secrets[key] ?? "") : String(secrets[key]));
    record(secrets.CODERABBIT_API_KEY === "a credential of the customer's own", "and the other credential plane in that file survives");
    record((statSync(boxFile("box-secrets.json")).mode & 0o777) === 0o600, "box-secrets.json lands 0600", (statSync(boxFile("box-secrets.json")).mode & 0o777).toString(8));

    step("gone: the copied operator key, by hash");
    const admin = (step2, body) => fetch(`${relay.base}/admin/tenants/${SLUG}/${step2}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${RELAY_TOKEN}` }, body: JSON.stringify(body),
    });
    record((await fetch(`${relay.base}/admin/tenants/${SLUG}/forget-provider-keys`, { method: "POST" })).status === 401, "the migration door needs CP_RELAY_TOKEN");
    const forgotten = await admin("forget-provider-keys", { prefix: sha12(OPERATOR_KEY) });
    const forgottenText = await forgotten.text();
    record(forgotten.status === 200, "the copied provider key is taken back out", `HTTP ${forgotten.status}`);
    record(!forgottenText.includes(OPERATOR_KEY), "and the answer does not carry what it deleted");
    const after = JSON.parse(readFileSync(boxFile("box-secrets.json"), "utf8")).secrets;
    record(!Object.values(after).includes(OPERATOR_KEY), `${sha12(OPERATOR_KEY)} is gone from box-secrets.json`);
    record(!readFileSync(path.join(stateDir, "endpoints.json"), "utf8").includes(OPERATOR_KEY), "and out of that tenant's saved endpoint rows");
    const tinyfish = await admin("forget-provider-keys", { prefix: sha12(OPERATOR_TINYFISH) });
    record(tinyfish.status === 200, "the copied TinyFish key is taken back out", `HTTP ${tinyfish.status}`);
    const connectors = JSON.parse(readFileSync(boxFile("connector-env-secrets.json"), "utf8"));
    record(connectors.servers?.tinyfish?.TINYFISH_API_KEY === undefined, `${sha12(OPERATOR_TINYFISH)} is gone from connector-env-secrets.json`);
    record(connectors.shell?.CODERABBIT_API_KEY === "a credential of the customer's own", "and the shell section beside it is untouched");
    record(after.SAND_OPENAI_COMPATIBLE_API_KEY === VIRTUAL_KEY, "the box still answers on its own virtual key");

    step("nothing was said out loud that should not have been");
    const log = relay.log();
    for (const [secret, what] of [[VIRTUAL_KEY, "the tenant's virtual key"], [OPERATOR_KEY, "the operator's provider key"],
      [OPERATOR_TINYFISH, "the operator's TinyFish key"], [RELAY_TOKEN, "the relay credential"],
      [MASTER, "the control plane's master"], [INSTANCE_PASSWORD, "the instance password"]]) {
      record(!log.includes(secret), `${what} is nowhere in the relay's log`);
    }
  } finally {
    cleanup();
  }
  return state;
}

// Standalone, so this leg is measurable before verify-proxy.mjs exists and on its own afterwards.
if (import.meta.url === `file://${process.argv[1]}`) {
  const state = await run();
  console.log("");
  console.log(state.failures === 0
    ? `verify-proxy --leg box: PASS (${state.checks} checks)`
    : `verify-proxy --leg box: FAIL (${state.failures} of ${state.checks} checks)`);
  process.exit(state.failures === 0 ? 0 : 1);
}
