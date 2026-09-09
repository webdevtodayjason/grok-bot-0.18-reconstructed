// PROXY-1, item A. The proxy's deploy, held to being repeatable and to the properties the whole
// design rests on.
//
// The compose is the security shape of the service: no published port, no Domain, no named volume,
// no ${VAR:?}. Every one of those is a rewrite Coolify performs or a hole it opens, each measured on
// the R750 before this wave, and each is the kind of thing that reads fine in review and fails in
// production months later. So they are pinned here rather than trusted to a comment.
//
// The scripts are held to the one thing hand steps never had: they can be run twice.
//
// Nothing here touches a real server, a real Coolify, a real docker or a real ~/.api_keys. `sudo`,
// `docker` and `ssh` are replaced by recorders on PATH, so the real commands are read back out of a
// log rather than executed, and the Coolify tool runs against an http server in this process.
//
// Every secret in here is generated for the run and thrown away with the temp directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(repo, "deploy/r750/proxy-install.sh");
const COOLIFY_TOOL = path.join(repo, "deploy/r750/proxy-coolify.mjs");
const COMPOSE = path.join(repo, "deploy/coolify/proxy.compose.yml");
const CONFIG = path.join(repo, "deploy/coolify/proxy-config/config.yaml");
const CONFIG_STAGE1 = path.join(repo, "deploy/coolify/proxy-config/config.stage1.yaml");
const BOOTSTRAP = path.join(repo, "deploy/coolify/proxy-config/bootstrap.json");
const ISOLATION = path.join(repo, "deploy/r750/box-isolation.sh");
const SYNC = path.join(repo, "deploy/r750/sync.sh");

const composeText = readFileSync(COMPOSE, "utf8");
// Comment lines stripped: the header explains at length WHY there is no port and no Domain, and a
// check that read the explanation as the thing it forbids could only ever fail.
const composeCode = composeText.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

const FAKE_MASTER = `sk-${randomBytes(24).toString("hex")}`;
const FAKE_SALT = randomBytes(32).toString("hex");
const FAKE_DB_PASSWORD = randomBytes(32).toString("hex");
const FAKE_ZAI_1 = `zai-one-${randomBytes(20).toString("hex")}`;
const FAKE_ZAI_2 = `zai-two-${randomBytes(20).toString("hex")}`;
const FAKE_MINIMAX = `minimax-${randomBytes(20).toString("hex")}`;
const FAKE_API_KEY = `${randomBytes(24).toString("base64url")}|fake`;

const temps = [];
function tempTree() {
  const root = mkdtempSync(path.join(tmpdir(), "proxy-deploy-"));
  temps.push(root);
  return root;
}
test.after(() => { for (const one of temps) rmSync(one, { recursive: true, force: true }); });

// ---- the compose ---------------------------------------------------------------------------------

test("the proxy compose publishes no port, which is the whole security shape of the service", () => {
  // Measured from Richard's box on the R750 2026-09-07 (TENANT-3): the host answers a box on 22, 80,
  // 443, 8000 and 3000, because container-to-bridge-gateway traffic hits INPUT where no bridge rule
  // can see it. So a published port here is the proxy handed to every box with no virtual key
  // involved, which is exactly what this wave exists to stop.
  assert.equal(/^\s*ports:/m.test(composeCode), false, "a ports line hands the proxy to every box on the machine");
  assert.equal(/expose:/m.test(composeCode), false);
});

test("and no Domain and no traefik label, so it is unreachable from the internet by construction", () => {
  assert.equal(/domain/i.test(composeCode), false, "a Domain would put a customer-billing proxy on the public internet");
  assert.equal(/traefik/i.test(composeCode), false);
});

test("and no named volume, because Coolify renames one and brings it back empty", () => {
  // A renamed Postgres volume is every virtual key in the fleet gone and every box answering 401.
  assert.equal(/^volumes:/m.test(composeCode), false, "no top-level volumes key");
  const mounts = [...composeCode.matchAll(/^\s+- (\S+):(\S+?)(?::(ro|rw))?$/gm)].map((m) => ({ source: m[1], target: m[2] }));
  assert.ok(mounts.length >= 2, `expected the two binds, found ${mounts.length}`);
  for (const mount of mounts) {
    assert.ok(mount.source.startsWith("/"), `${mount.source} is a named volume, not a host path`);
  }
});

test("and both binds are DIRECTORIES, because Coolify reads a single-file bind into its own database", () => {
  // A bind to a FILE becomes a LocalFileVolume row, and one Save in the Storages UI writes Coolify's
  // stale copy back over the real file. config.yaml is therefore mounted as the directory that holds
  // it, and deploy/r750/proxy-install.sh is what puts the file in the directory.
  const mounts = [...composeCode.matchAll(/^\s+- (\/\S+):(\S+?)(?::(ro|rw))?$/gm)].map((m) => m[1]);
  assert.deepEqual(mounts.sort(), ["/data/titanbot-proxy/config", "/data/titanbot-proxy/postgres"]);
  for (const source of mounts) {
    assert.equal(/\.(ya?ml|json|conf|env)$/.test(source), false, `${source} looks like a file, and a file bind is the Coolify trap`);
  }
});

test("and its storage is a SIBLING of the tenant root, not a child, so the backup job cannot mistake it for a customer", () => {
  // deploy/backup/snapshot.sh walks /data/titanbot one directory at a time and skips exactly one
  // name. Under there the proxy would be reported as a customer in every manifest and its Postgres
  // taken as a live file copy, which for a database is a torn copy that restores without complaint.
  const mounts = [...composeCode.matchAll(/^\s+- (\/\S+):/gm)].map((m) => m[1]);
  for (const source of mounts) {
    assert.equal(source.startsWith("/data/titanbot/"), false, `${source} is under the tenant root`);
    assert.ok(source.startsWith("/data/titanbot-proxy/"), `${source} is not under the proxy's own root`);
  }
});

test("and uses no ${VAR:?} or ${VAR:-}, because Coolify makes the field name from everything in the braces", () => {
  // ${PROXY_MASTER_KEY:?} produces a field literally named "PROXY_MASTER_KEY:?", which is not a
  // legal shell name: the line is dropped and the deploy fails on a variable no field in the UI can
  // set. The same trap docker-compose.yml documents at TITANBOT_GATEWAY_TOKEN.
  const refs = [...composeCode.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(refs.length >= 6, `expected the environment references, found ${refs.length}`);
  for (const ref of refs) {
    assert.match(ref, /^[A-Z_][A-Z0-9_]*$/, `\${${ref}} is not a plain name, so Coolify will drop the line`);
  }
});

test("and carries both role labels, because every script finds these containers by label and never by name", () => {
  // Coolify overwrites container_name with "<service>-<resource uuid>", so a name in a script goes
  // stale on the next redeploy. box-isolation.sh, proxy-install.sh --pin-url and snapshot.sh all
  // look these up.
  assert.match(composeCode, /^\s+com\.titanbot\.role: proxy$/m);
  assert.match(composeCode, /^\s+com\.titanbot\.role: proxy-db$/m);
  assert.equal(/container_name:/.test(composeCode), false, "Coolify overwrites container_name, so nothing may rely on one");
});

test("the proxy is on the shared network under a stable alias, and its database is not on it at all", () => {
  // The alias is what makes http://titanbot-proxy:4000 resolve after Coolify has renamed the
  // container. The database is off that bridge entirely, so a customer's box has no route to every
  // tenant's spend and key rows rather than a route with one nftables rule in front of it.
  assert.match(composeCode, /^\s+aliases:\n\s+- titanbot-proxy$/m);
  // The database's own block only: from its service key to the next top-level key, so the file's
  // own `networks:` declaration at the bottom is not read as the database joining one.
  const dbBlock = (composeCode.split(/^ {2}titanbot-proxy-db:$/m)[1] ?? "").split(/^\S/m)[0];
  assert.ok(dbBlock.includes("postgres:16"), "the database block was not found where this expects it");
  assert.equal(/titanbot-net/.test(dbBlock), false, "the proxy database must not be on the shared bridge");
  assert.equal(/^\s+networks:/m.test(dbBlock), false, "and must declare no network of its own, so it has only Coolify's");
  assert.match(composeCode, /^\s+titanbot-net:\n\s+external: true\n\s+name: titanbot-net$/m);
});

test("the image is pinned to a bare version, because the -stable suffix is a 404 on this registry", () => {
  // Measured on this Mac 2026-09-08: `docker manifest inspect` answers for
  // docker.litellm.ai/berriai/litellm-database:v1.100.0 and does not for :v1.100.0-stable.
  const image = /image: (docker\.litellm\.ai\/berriai\/litellm-database:\S+)/.exec(composeCode)?.[1];
  assert.ok(image, "the proxy image is not the pinned litellm-database one");
  assert.match(image, /:v\d+\.\d+\.\d+$/, "pinned to an exact version, with no -stable suffix and no floating tag");
});

test("neither config file holds a key at all, only os.environ references", () => {
  // This is why these files can live in git and sit readable in the bind mount, and it is the
  // difference between this design and the box-secrets.json copies they replace.
  for (const [label, file] of [["config.yaml", CONFIG], ["config.stage1.yaml", CONFIG_STAGE1]]) {
    const configText = readFileSync(file, "utf8");
    const apiKeys = [...configText.matchAll(/^\s*api_key:\s*(\S+)/gm)].map((m) => m[1]);
    for (const value of apiKeys) assert.match(value, /^os\.environ\/[A-Z0-9_]+$/, `${label}: ${value} is a literal key in a file in git`);
    // And every name it refers to is one the compose supplies, or the container gets a model with no
    // credential that 401s on a customer's turn.
    const referenced = new Set([...configText.matchAll(/os\.environ\/([A-Z0-9_]+)/g)]
      .filter((m) => !/^\s*#/.test(configText.slice(configText.lastIndexOf("\n", m.index) + 1, m.index)))
      .map((m) => m[1]));
    for (const name of referenced) {
      assert.ok(composeCode.includes(`${name}: \${${name}}`), `${label} wants ${name} and the compose does not supply it`);
    }
  }
  // Stage one is the file that still carries the pool, so it is the one that must still carry keys.
  const stage1 = readFileSync(CONFIG_STAGE1, "utf8");
  assert.ok([...stage1.matchAll(/^\s*api_key:\s*(\S+)/gm)].length >= 3,
    "config.stage1.yaml is what carries the fleet across the first restart and must still declare its subscriptions");
});

// ---- PROVIDERS-1: the file is a bootstrap now, and there are two staged forms ----------------------

test("both staged config files parse as YAML", async () => {
  // A real parse, not a regex. An indentation slip in these files is not an error at startup, it is
  // SILENCE -- LiteLLM ignores a key it does not recognise -- so the parse is worth its own check.
  // Measured separately and more strongly on this Mac 2026-09-08: both files were booted in a real
  // docker.litellm.ai/berriai/litellm-database:v1.100.0 against a non-empty Postgres, stage two in
  // 11.9 s and stage one in 16.4 s, and both answered /health/readiness 200 and served a turn.
  for (const file of [CONFIG, CONFIG_STAGE1]) {
    const parsed = await run("python3", ["-c",
      "import sys,yaml,json;d=yaml.safe_load(open(sys.argv[1]));print(json.dumps(sorted(d.keys())))", file]);
    const keys = JSON.parse(parsed.stdout.trim());
    assert.ok(keys.includes("general_settings"), `${path.basename(file)} has no general_settings`);
    assert.ok(keys.includes("mcp_servers"), `${path.basename(file)} has no mcp_servers`);
  }
});

test("the shipped config.yaml declares no model_list and no router fallbacks, because those are database rows now", async () => {
  const parsed = await run("python3", ["-c",
    "import sys,yaml,json;d=yaml.safe_load(open(sys.argv[1]));"
    + "print(json.dumps({'model_list':d.get('model_list'),'fallbacks':(d.get('router_settings') or {}).get('fallbacks'),"
    + "'store':(d.get('general_settings') or {}).get('store_model_in_db'),"
    + "'reload':(d.get('general_settings') or {}).get('proxy_config_reload_interval_seconds'),"
    + "'errors':(d.get('general_settings') or {}).get('disable_error_logs')}))", CONFIG]);
  const shipped = JSON.parse(parsed.stdout.trim());
  assert.ok(shipped.model_list == null, "config.yaml still declares a model_list, which would win over the panel");
  assert.ok(shipped.fallbacks == null, "config.yaml still declares router fallbacks, which the panel can no longer require");
  assert.equal(shipped.store, true, "store_model_in_db is the line PROVIDERS-1 turns on");
  assert.equal(shipped.reload, 10, "the reload interval is pinned, so a future second worker is bounded");
  // NOT set, deliberately. It is read in exactly one place, _should_track_errors_in_db(), and
  // turning it on stops a FAILED request being written to the spend log at all -- which would make
  // "zero failed requests during the key roll" true because nothing could ever be written rather
  // than because nothing failed. A gate that cannot fail is not a gate.
  assert.ok(shipped.errors == null, "disable_error_logs must stay unset or a failed request can never be counted");

  // Stage one is the opposite: it is what carries the fleet across the first restart.
  const stage1Parsed = await run("python3", ["-c",
    "import sys,yaml,json;d=yaml.safe_load(open(sys.argv[1]));"
    + "print(json.dumps({'names':sorted({m['model_name'] for m in d.get('model_list') or []}),"
    + "'fallbacks':(d.get('router_settings') or {}).get('fallbacks'),"
    + "'store':(d.get('general_settings') or {}).get('store_model_in_db')}))", CONFIG_STAGE1]);
  const stage1 = JSON.parse(stage1Parsed.stdout.trim());
  assert.ok(stage1.names.includes("plan-zai"), "config.stage1.yaml must still serve plan-zai across the first restart");
  assert.ok(stage1.names.includes("plan-zai-vision"), "and the vision pool, or every screenshot-carrying turn fails");
  assert.ok(Array.isArray(stage1.fallbacks) && stage1.fallbacks.length > 0,
    "and must still declare the vision fallback, so the fleet is covered before the seed runs");
  assert.equal(stage1.store, true, "stage one is the restart that turns store_model_in_db on");
});

test("neither config declares allowed_routes, because the boundary moved to each key", async () => {
  // The global door list is an EXACT STRING MATCH with no wildcards, checked before the key is
  // looked up, so it refuses the master key too and cannot express PATCH /credentials/{name} or
  // PATCH /model/{id}/update -- the two path-parameter routes the panel is built on. It also could
  // not tell a tenant from the operator, which is what left PROXY-8 open. A list that came back
  // would take the panel off the air with a 403 and no other clue.
  for (const file of [CONFIG, CONFIG_STAGE1]) {
    const parsed = await run("python3", ["-c",
      "import sys,yaml,json;d=yaml.safe_load(open(sys.argv[1]));"
      + "print(json.dumps((d.get('general_settings') or {}).get('allowed_routes')))", file]);
    assert.equal(JSON.parse(parsed.stdout.trim()), null,
      `${path.basename(file)} declares a global allowed_routes list again`);
    // And the paragraph that replaced it is still there, so nobody adds the list back by reflex.
    assert.match(readFileSync(file, "utf8"), /allowed_routes/,
      `${path.basename(file)} no longer says what the door list did or what replaced it`);
  }
});

test("the pass-through block is inside general_settings in both files, which is the only place LiteLLM reads it", async () => {
  // MEASURED ON THE R750 2026-09-08 with the identical entries at the TOP LEVEL: the proxy started
  // clean, logged nothing, listed no /tinyfish path in its own openapi.json and answered 404 on
  // every call to one, while docs/PROXY.md carried a measured table for the route. mcp_servers is
  // the opposite and is read from the top level. Either one in the other's place is silence.
  for (const file of [CONFIG, CONFIG_STAGE1]) {
    const parsed = await run("python3", ["-c",
      "import sys,yaml,json;d=yaml.safe_load(open(sys.argv[1]));"
      + "print(json.dumps({'nested':[e['path'] for e in ((d.get('general_settings') or {}).get('pass_through_endpoints') or [])],"
      + "'top':d.get('pass_through_endpoints') is not None,"
      + "'mcp':d.get('mcp_servers') is not None}))", file]);
    const where = JSON.parse(parsed.stdout.trim());
    assert.ok(where.nested.includes("/tinyfish/fetch") && where.nested.includes("/tinyfish/search"),
      `${path.basename(file)}: the TinyFish pass-throughs are not under general_settings`);
    assert.equal(where.top, false, `${path.basename(file)}: a pass_through_endpoints block at the top level is silence`);
    assert.equal(where.mcp, true, `${path.basename(file)}: mcp_servers must stay at the TOP level`);
  }
});

test("bootstrap.json holds no value that looks like a key, and every credential slot is an environment NAME", () => {
  const text = readFileSync(BOOTSTRAP, "utf8");
  const bootstrap = JSON.parse(text);
  assert.ok(Number.isInteger(bootstrap.schemaVersion), "bootstrap.json carries no schema version");

  // Every credential slot names an environment variable and holds nothing.
  for (const one of bootstrap.credentials ?? []) {
    assert.match(one.env, /^[A-Z0-9_]+$/, `${one.credentialName} names ${one.env}, which is not an environment name`);
    assert.equal(one.value, undefined, `${one.credentialName} carries a value, and this file is in git`);
    assert.ok(composeCode.includes(`${one.env}: \${${one.env}}`),
      `bootstrap.json wants ${one.env} and the compose does not supply it, so the seed would write an empty credential`);
  }

  // And nothing anywhere in the file is key-shaped. A long opaque string with no url and no path
  // separator is what a pasted credential looks like; model names, paths and urls are not that.
  const suspicious = [...text.matchAll(/"([A-Za-z0-9_\-.]{28,})"/g)].map((m) => m[1])
    .filter((one) => !/^https?:/.test(one));
  assert.deepEqual(suspicious, [], `bootstrap.json holds something key-shaped: ${suspicious.join(", ")}`);

  // The rule that keeps a routing target off a customer's screen. plan-zai-vision exists only so a
  // screenshot-carrying turn has somewhere to go; a card for it would be a model nobody can choose
  // and a name nobody recognises. The next mint would have produced exactly that.
  const visible = (bootstrap.planModels ?? []).filter((one) => one.customerVisible);
  const hidden = (bootstrap.planModels ?? []).filter((one) => !one.customerVisible);
  assert.ok(visible.length > 0, "bootstrap.json seeds nothing a customer can see");
  for (const one of visible) {
    assert.ok(one.customerName && one.customerLabel,
      `${one.modelName} is customer-visible with no name a person reads, so the routing alias would end up on their screen`);
    assert.ok(one.visionFallback,
      `${one.modelName} is customer-visible with no vision fallback, which is PROXY-10 waiting to happen again`);
  }
  assert.ok(hidden.some((one) => one.modelName.endsWith("-vision")),
    "the vision model must be seeded NOT customer-visible");
  for (const one of hidden) {
    assert.ok(!one.customerName, `${one.modelName} is hidden and still carries a customer name`);
  }

  // The fallback map is seeded AFTER the deployments and never names a model that is not seeded, or
  // POST /fallback answers 400 "Invalid fallback models" (measured on this Mac 2026-09-08).
  const seeded = new Set((bootstrap.planModels ?? []).map((one) => one.modelName));
  for (const pair of bootstrap.fallbacks ?? []) {
    assert.ok(seeded.has(pair.model), `the fallback map names ${pair.model}, which nothing seeds`);
    for (const target of pair.fallbackModels) {
      assert.ok(seeded.has(target), `the fallback map points ${pair.model} at ${target}, which nothing seeds`);
      assert.notEqual(target, pair.model, "a model cannot be its own fallback: the proxy answers 400");
    }
  }
});

test("the compose turns store_model_in_db ON and still pins one worker, which is what 'the next request' rests on", () => {
  assert.match(composeCode, /STORE_MODEL_IN_DB:\s*"True"/,
    "the compose and general_settings must agree; the file wins either way, but which one wins is not a thing to remember");
  // MEASURED on this Mac 2026-09-08 with one worker: a deployment added with POST /model/new served
  // its first request 10 ms after the add answered, and a deleted one stopped answering 8 ms after.
  // With two workers that becomes "within proxy_config_reload_interval_seconds" and the panel's copy
  // has to change with it.
  assert.match(composeCode, /"--num_workers",\s*"1"/,
    "the panel tells the operator a change takes effect on the next request, and that rests on one worker");
});

test("the installer ships both staged forms and the bootstrap, or a rollback has to fetch a file mid-incident", () => {
  const installText = readFileSync(INSTALL, "utf8");
  assert.match(installText, /config\.stage1\.yaml/, "proxy-install.sh does not install the stage one file");
  assert.match(installText, /bootstrap\.json/, "proxy-install.sh does not install bootstrap.json");
  assert.match(installText, /--stage/, "proxy-install.sh has no way to pick which staged form is active");
  // The order that is load bearing: the per-key backfill runs BEFORE the restart that removes the
  // global list, or there is a window in which the admin surface is open to every box on the bridge.
  assert.match(installText, /proxy limits --all/, "proxy-install.sh never names the per-key backfill");
  assert.match(installText, /proxy seed/, "proxy-install.sh never names the seed step");
  // And sync.sh has to actually ship the directory, or the installer fails on the server.
  const syncText = readFileSync(SYNC, "utf8");
  assert.match(syncText, /proxy-config/, "sync.sh does not ship the proxy config directory");
});

test("the restore drill restores the proxy dump and its salt together, because one without the other is unreadable", () => {
  // Verified 2026-09-08: deploy/backup/snapshot.sh already carried cp.env and already pg_dumped the
  // proxy database, and this drill mentioned NEITHER. That did not matter much while the database
  // held virtual keys and spend rows; it matters now that it holds every provider subscription the
  // operator has, encrypted under PROXY_SALT_KEY, with no second copy anywhere.
  const drill = readFileSync(path.join(repo, "deploy/backup/restore-drill.sh"), "utf8");
  assert.match(drill, /proxy\/litellm\.sql/, "the drill never looks for the proxy dump");
  assert.match(drill, /PROXY_SALT_KEY/, "the drill never looks for the salt that makes the dump readable");
  assert.match(drill, /PROXY_BAD/, "the drill has no verdict for the proxy half");
  // And the value is never printed: a length and a hash prefix, the same rule every script here
  // follows. Every line that mentions it has to be one of four things -- reading it, measuring its
  // length, hashing it, or handing it to the container that does the decrypt -- and a fifth kind of
  // line is a key on somebody's terminal.
  for (const line of drill.split("\n")) {
    if (!line.includes("$SALT") && !line.includes("SALT=")) continue;
    const reading = /SALT=/.test(line);
    const length = /\$\{#SALT\}/.test(line);
    const hashed = /(sha256sum|shasum)/.test(line);
    const handedOver = /-e "LITELLM_SALT_KEY=\$SALT"|TB_SALT="\$SALT"/.test(line);
    const tested = /^\s*(if|elif)\s+\[\s+-[zn]\s+"\$SALT"\s+\]/.test(line);
    assert.ok(reading || length || hashed || handedOver || tested,
      `this line could put the salt on a terminal: ${line.trim()}`);
  }
  assert.match(drill, /\$\{#SALT\}/, "the drill never reports the salt's length, so it proves nothing about which salt it found");
});

// ---- box-isolation.sh ----------------------------------------------------------------------------

test("box-isolation.sh finds the proxy by its label and never by an address written down", () => {
  const script = readFileSync(ISOLATION, "utf8");
  // Discovered exactly the way the relay is. Coolify renames the container on every redeploy and
  // docker hands out a fresh bridge address with it, so a literal here would be a rule that quietly
  // stops matching -- and the symptom would be every customer's inference, not a log line.
  assert.match(script, /docker ps --filter label=com\.titanbot\.role=proxy --format '\{\{\.Names\}\}'/);
  assert.match(script, /^PROXY_ADDR="\$\(address_of "\$PROXY_NAME"\)"$/m);
  // The accept rule is built from that lookup.
  assert.match(script, /ip daddr %s tcp dport %s accept comment "a box asks the proxy for an answer"/);
  assert.match(script, /"\$BR" "\$SET" "\$PROXY_ADDR" "\$PROXY_PORT"/);
  // And no address is hard-coded in any RULE. Comments are read separately below, because
  // TENANT-3's header records exactly which addresses were measured open on which host and on which
  // day, and a measurement is worth more written down than paraphrased. What must never appear is a
  // literal the script acts on.
  const code = script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const literals = [...code.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]);
  // One exception, named rather than pattern-matched: --verify opens a socket to 1.1.1.1:443 before
  // it believes a "closed" result. Without that sanity leg a broken probe reads as a locked-down
  // host, which is exactly the false negative TENANT-3 already recorded once (a probe written with
  // `sh`, which is dash on the box image and has no /dev/tcp, reported every port shut).
  const unexplained = literals.filter((address) => address !== "1.1.1.1");
  assert.deepEqual(unexplained, [], `an address is written into the script: ${unexplained.join(", ")}`);
  for (const line of code.split("\n").filter((l) => l.includes("1.1.1.1"))) {
    assert.match(line, /dev\/tcp\/1\.1\.1\.1\/443|^\s*say /, `1.1.1.1 is used for something other than the sanity leg: ${line.trim()}`);
  }
});

test("and its accept rule sits ahead of the drop, so the drop is still what catches everything else", () => {
  const script = readFileSync(ISOLATION, "utf8");
  const proxyAt = script.indexOf('comment "a box asks the proxy for an answer"');
  const dropAt = script.indexOf('drop comment "one customer box reaches nothing else on this bridge"');
  assert.ok(proxyAt > 0 && dropAt > 0);
  assert.ok(proxyAt < dropAt, "an accept after the drop never matches");
});

test("and --verify measures both halves: every box reaches the proxy, nothing reaches its database", () => {
  const script = readFileSync(ISOLATION, "utf8");
  assert.match(script, /reaches the proxy on \$PROXY_PORT/);
  assert.match(script, /\$PROXY_DB_PORT/);
  assert.match(script, /^PROXY_DB_PORT="\$\{TITANBOT_PROXY_DB_PORT:-5432\}"$/m);
});

test("the host guard remembers its fingerprint somewhere the user unit can actually write", () => {
  // Measured on the R750 2026-09-09: /run/titanbot is root-owned 0755, this runs as a systemd --user
  // unit as the operator, and the mkdir and the write were both swallowed by `|| true`. So the
  // fingerprint was never stored, PREVIOUS read empty every tick, and the table was rebuilt every
  // 60 seconds -- the accept rule's handle walked 2086 -> 2088 -> 2090 over 90 seconds with its
  // counter resetting each time. The boundary still held; the counters did not, and the counters are
  // the entire evidence base for letting a port into the drop set.
  const script = readFileSync(ISOLATION, "utf8");
  assert.match(script, /HOST_GUARD_STATE="\$\{TITANBOT_HOST_GUARD_STATE:-\$\{XDG_RUNTIME_DIR:-\/run\}\/titanbot\/host-guard\.fingerprint\}"/);
  // And it says so when it cannot, because that is what hid this.
  assert.match(script, /WARNING cannot write \$HOST_GUARD_STATE/);
  assert.equal(
    /printf '%s\\n' "\$FINGERPRINT" > "\$HOST_GUARD_STATE" 2>\/dev\/null \|\| true/.test(script),
    false,
    "the silent fallback is what made a dead instrument look like a working one",
  );
});

test("and a port only sits in the drop set on evidence the counters could actually have carried", () => {
  // The drop set holds the three ports TENANT-3 is about and nothing else. NFS, Samba and ollama
  // were moved back to watch-only because the window that justified them was not accumulating; they
  // rejoin on a window that is. This asserts the default, not the operator's env override.
  const script = readFileSync(ISOLATION, "utf8");
  assert.match(script, /^DROP_PORTS="\$\{TITANBOT_HOST_GUARD_DROP_PORTS:-22,47291,8000\}"$/m);
  assert.match(script, /^WATCH_PORTS="\$\{TITANBOT_HOST_GUARD_WATCH_PORTS:-2049,445,11434,5000,80,443\}"$/m);
});

test("verify-deploy's box-to-host leg matches the lines box-isolation.sh actually writes", () => {
  // This leg was green-by-inconclusive on every run, for two independent reasons, and an
  // INCONCLUSIVE gate tells an operator exactly as much as a gate that cannot fail. (1) Its
  // watch-only pattern demanded a space before `watch-only`, while the script writes the marker in
  // parentheses. (2) It only accepted `closed ... -> host` as evidence, and the script prints that
  // line ONLY when nothing answered on any guarded port at all; if any watch-only port answers it
  // prints `note` instead. On the R750, 80 and 443 are Coolify's own proxy and always answer, so
  // no correct run could ever produce the line the leg was looking for.
  //
  // Rather than restate the patterns here, this reads them out of the gate and runs them against
  // the real shapes, so the two files cannot drift apart again.
  const gate = readFileSync(path.join(repo, "scripts/verify-deploy.mjs"), "utf8");
  const patternFor = (name) => {
    const line = gate.split("\n").find((l) => l.includes(`const ${name} = out.split`));
    assert.ok(line, `verify-deploy.mjs no longer defines ${name}`);
    const source = /\/\^(.+?)\/\.test\(l\)/.exec(line);
    assert.ok(source, `could not read the ${name} pattern out of the gate`);
    return new RegExp(`^${source[1]}`);
  };

  // Copied from a real --verify run on the R750, 2026-09-09.
  const noteLine = "note   titanbot-box-atonqjq7zx593jsacaccpfau -> host 192.168.32.1 also answers on 2049 445 11434 5000 80 443 (watch-only; add to the drop set once its shadow counter reads zero)";
  const openLine = "OPEN   titanbot-box-atonqjq7zx593jsacaccpfau -> host 192.168.32.1 on 22; a customer's agent reaches the machine that runs every other customer";
  const closedLine = "closed titanbot-box-atonqjq7zx593jsacaccpfau -> host 192.168.32.1: nothing answered on 22 47291 8000";

  assert.equal(patternFor("watched").test(noteLine), true, "a watch-only note is a probed address and has to count as one");
  assert.equal(patternFor("openHost").test(openLine), true, "an open drop-set port has to fail the leg");
  assert.equal(patternFor("closedHost").test(closedLine), true);
  // And the shapes must not be confused for one another.
  assert.equal(patternFor("openHost").test(noteLine), false, "a watch-only note is not an open drop-set port");

  // The pass condition counts notes, not just closed lines.
  assert.match(gate, /closedHost\.length \+ watched\.length === 0/);
});

test("the host guard exempts a container on every address family it holds, not just IPv4", () => {
  // The bug this pins, measured on the R750 2026-09-09 with the guard ALREADY in drop mode: the
  // exemption was one `ip saddr` line, and `ip saddr` in an inet table matches IPv4 only. The two
  // drop lines match on iifname, which has no family, so they cover v6 as well. An exempt container
  // therefore got past on v4 and fell into the drop on v6 -- and the coolify bridge really does
  // carry a global v6 prefix, its gateway address really is fib-local, and sshd really does listen
  // on [::]:22. The one container that must never be cut off is the one the machine is administered
  // from, and the way back in would have been the panel that had just stopped answering.
  const script = readFileSync(ISOLATION, "utf8");
  assert.match(script, /GlobalIPv6Address/, "the v6 addresses have to be read before they can be exempted");
  assert.match(script, /ip6 saddr \{ %s \} counter accept/, "and emitted as their own rule, because one rule cannot carry both families");
  // The drop stays family-agnostic on purpose. A v6 carve-out there would be a hole in the boundary
  // itself, which is the opposite of the fix.
  assert.equal(/ip6 daddr|ip6 saddr .*drop/.test(script), false, "only the exemption grew; the drop must stay family-agnostic");
});

test("and a container with no IPv6 contributes no IPv6 rule, because docker prints an absent one as text", () => {
  // `docker inspect` renders a missing address as Go's "invalid IP". A set built from that string
  // is a rule that matches nothing while reading as though it worked, so the filter is a grep for
  // an actual colon rather than a non-empty test.
  const script = readFileSync(ISOLATION, "utf8");
  assert.match(script, /grep -E '\^\[0-9a-fA-F:\]\+:\[0-9a-fA-F:\]\*\$'/);
  // And an absent v6 address must never trip the fail-closed latch: most containers here are v4
  // only, and refusing to install the boundary over that would take the boundary away for no fault.
  const guardBlock = script.slice(script.indexOf("exempt_container() {"), script.indexOf("if [ \"$HOST_GUARD\" != off ]"));
  const v6Block = guardBlock.slice(guardBlock.indexOf("found6"));
  assert.equal(/HOST_GUARD_BLOCKED/.test(v6Block), false, "a container with no v6 is not a fault and must not block the install");
});

test("and --verify no longer throws away the count of boxes the console cannot reach", () => {
  // Pre-existing, found while adding the proxy legs: `broken` was incremented with no starting value
  // and never read, so a run with a customer's console dead still exited PASS. It is initialised and
  // folded into the verdict now, which is what the line always said it was doing.
  const script = readFileSync(ISOLATION, "utf8");
  assert.match(script, /^\s+broken=0$/m, "broken has to start somewhere or the increment is unbound under set -u");
  assert.match(script, /\[ "\$broken" = 0 \] \|\| die /, "and it has to be read, or the check is decoration");
});

// ---- sync.sh -------------------------------------------------------------------------------------

test("sync.sh ships the installer and the compose, because the server has nothing to run without them", () => {
  // Continuations joined first: the rsync that ships the deploy scripts is several lines long, and a
  // per-line grep would read only the first of them.
  const flattened = readFileSync(SYNC, "utf8").replace(/\\\n\s*/g, " ");
  const shipped = [...flattened.matchAll(/^rsync .*$/gm)].map((m) => m[0]).join("\n");
  assert.match(shipped, /proxy-install\.sh/, "it runs on the R750, so it has to be shipped there");
  assert.match(shipped, /deploy\/coolify\/proxy\.compose\.yml/);
  assert.match(shipped, /deploy\/coolify\/proxy-config\//, "without the config the installer stops by name and the proxy serves no model");
  assert.equal(
    /proxy-coolify\.mjs/.test(shipped),
    false,
    "the Coolify half runs from the Mac and holds the api key while it runs; it does not belong on the server",
  );
});

// ---- the install script --------------------------------------------------------------------------

// `sudo`, `docker` and `ssh` replaced by a recorder. Everything the scripts would have done to this
// machine lands in a log file instead, which is also how the arguments are read back below.
function stubBin(logPath, { alias = "titanbot-proxy", proxyName = "titanbot-proxy-abc123", cpEnvPath = "" } = {}) {
  const dir = path.join(tempTree(), "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "${logPath}"
# install -d and install -m have to really happen, or the next step has nothing to write into.
case "$1" in install) shift; exec install "$@" ;; esac
exit 0
`, { mode: 0o755 });
  writeFileSync(path.join(dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${logPath}"
case "$1" in
  ps) printf '%s\\n' "${proxyName}" ;;
  inspect) printf '%s %s\\n' "${alias}" "${proxyName}" ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(path.join(dir, "ssh"), `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "${logPath}"
[ -f "${cpEnvPath}" ] && cat "${cpEnvPath}"
exit 0
`, { mode: 0o755 });
  return dir;
}

// A release tree with the three files the installer insists on before it will make anything: both
// staged forms of the config and the bootstrap the seed reads. All three, because the one that is
// not active is what a rollback reinstalls, and having to fetch it during an incident is how an
// incident gets longer.
function releaseTree() {
  const root = path.join(tempTree(), "titanbot");
  mkdirSync(path.join(root, "deploy/coolify/proxy-config"), { recursive: true });
  writeFileSync(path.join(root, "deploy/coolify/proxy-config/config.yaml"), readFileSync(CONFIG, "utf8"));
  writeFileSync(path.join(root, "deploy/coolify/proxy-config/config.stage1.yaml"), readFileSync(CONFIG_STAGE1, "utf8"));
  writeFileSync(path.join(root, "deploy/coolify/proxy-config/bootstrap.json"), readFileSync(BOOTSTRAP, "utf8"));
  return root;
}

test("the installer's dry run prints every command and changes nothing", async () => {
  const root = releaseTree();
  const proxyRoot = path.join(tempTree(), "titanbot-proxy");
  const { stdout } = await run("bash", [INSTALL], {
    env: {
      ...process.env,
      TITANBOT_DRY_RUN: "1",
      TITANBOT_ROOT: root,
      TITANBOT_PROXY_ROOT: proxyRoot,
      TITANBOT_UID: "1001",
      TITANBOT_GID: "1001",
    },
  });

  assert.match(stdout, /dry run: nothing below is executed/);
  assert.match(stdout, new RegExp(`would run: sudo install -d -o 1001 -g 1001 -m 0750 ${proxyRoot}$`, "m"));
  assert.match(stdout, new RegExp(`would run: sudo install -d -o 1001 -g 1001 -m 0755 ${proxyRoot}/config$`, "m"));
  // 999 is the uid the postgres image runs as, measured, not assumed, and 0700 is what postgres
  // insists on: it refuses to start on a data directory with any group or other bit set.
  assert.match(stdout, new RegExp(`would run: sudo install -d -o 999 -g 999 -m 0700 ${proxyRoot}/postgres$`, "m"));
  assert.match(stdout, /would create .*cp\.env at mode 0600/);

  assert.throws(() => statSync(proxyRoot), /ENOENT/, "a dry run must not make the storage");
  assert.throws(() => statSync(path.join(root, "cp.env")), /ENOENT/, "a dry run must not write cp.env");
});

test("the installer refuses to run as root, because everything it makes would be root-owned", async () => {
  const root = releaseTree();
  await assert.rejects(
    run("bash", [INSTALL], {
      env: { ...process.env, TITANBOT_DRY_RUN: "1", TITANBOT_ROOT: root, TITANBOT_UID: "0", TITANBOT_GID: "0" },
    }),
    (error) => {
      assert.match(String(error.stderr), /run this as sem, not as root/);
      return true;
    },
  );
});

test("the installer names the missing config rather than leaving a proxy that serves nothing", async () => {
  const root = releaseTree();
  rmSync(path.join(root, "deploy/coolify/proxy-config/config.yaml"));
  await assert.rejects(
    run("bash", [INSTALL], { env: { ...process.env, TITANBOT_DRY_RUN: "1", TITANBOT_ROOT: root, TITANBOT_UID: "1001", TITANBOT_GID: "1001" } }),
    (error) => {
      assert.match(String(error.stderr), /config\.yaml is missing -- run deploy\/r750\/sync\.sh/);
      return true;
    },
  );
});

test("a real install generates the three secrets once, and a second run keeps every one of them", async () => {
  const root = releaseTree();
  const proxyRoot = path.join(tempTree(), "titanbot-proxy");
  const log = path.join(tempTree(), "commands.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${stubBin(log)}:${process.env.PATH}`,
    TITANBOT_ROOT: root,
    TITANBOT_PROXY_ROOT: proxyRoot,
    TITANBOT_UID: String(process.getuid()),
    TITANBOT_GID: String(process.getgid()),
    TITANBOT_PROXY_DB_UID: String(process.getuid()),
    TITANBOT_PROXY_DB_GID: String(process.getgid()),
  };

  const first = await run("bash", [INSTALL], { env });
  const cpEnv = path.join(root, "cp.env");
  assert.equal(statSync(cpEnv).mode & 0o777, 0o600, "cp.env is readable by its owner only");

  const written = readFileSync(cpEnv, "utf8");
  const master = /^PROXY_MASTER_KEY=(.+)$/m.exec(written)?.[1];
  const salt = /^PROXY_SALT_KEY=(.+)$/m.exec(written)?.[1];
  const dbPassword = /^PROXY_DB_PASSWORD=(.+)$/m.exec(written)?.[1];
  assert.match(String(master), /^sk-[0-9a-f]{48}$/, "sk- prefixed, which half of LiteLLM's tooling assumes");
  assert.match(String(salt), /^[0-9a-f]{64}$/);
  assert.match(String(dbPassword), /^[0-9a-f]{64}$/);
  assert.notEqual(master, salt);
  assert.notEqual(master, dbPassword);

  for (const value of [master, salt, dbPassword]) {
    assert.equal(first.stdout.includes(value), false, "a secret was printed");
  }
  // The config really landed, and it is readable by whatever uid the image runs as.
  assert.equal(statSync(path.join(proxyRoot, "config/config.yaml")).mode & 0o777, 0o644);
  assert.match(first.stdout, /it refers to these environment names/);
  assert.match(first.stdout, /PROXY_ZAI_KEY_1/);
  // The report names what a fresh install SEEDS, which as of PROVIDERS-1 comes out of bootstrap.json
  // rather than out of a model_list this file no longer carries.
  assert.match(first.stdout, /a fresh install seeds these plan model names.*plan-minimax plan-zai plan-zai-vision/);
  assert.match(first.stdout, /this file declares no model at all, which is stage 2/);

  // And it names ONLY environment variables that exist. The first cut of that line scraped both
  // whole files for `os.environ/...`, which matched the prose in them: it printed `NAME`, out of a
  // sentence in bootstrap.json explaining that an unset pass-through forwards the literal string
  // "os.environ/NAME" to the vendor, and PROXY_BROWSER_KEY out of a commented-out stub nothing
  // reads. An operator who goes looking for a variable the installer invented loses an hour, so the
  // shape of that line is asserted rather than left to a reader to notice.
  const envLine = first.stdout.split("\n").find((line) => line.includes("it refers to these environment names"));
  const printedNames = String(envLine).split(":").pop().trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(
    printedNames,
    ["PROXY_MINIMAX_KEY", "PROXY_TINYFISH_KEY_1", "PROXY_TINYFISH_KEY_2", "PROXY_ZAI_KEY_1", "PROXY_ZAI_KEY_2"],
    "the installer named an environment variable that is not really referenced",
  );

  // The second run. A new master here would lock the control plane out of the proxy, and a new salt
  // would make every stored credential unreadable.
  const second = await run("bash", [INSTALL], { env });
  assert.equal(readFileSync(cpEnv, "utf8"), written, "cp.env is byte for byte what the first run left");
  assert.match(second.stdout, /PROXY_MASTER_KEY is already in .*cp\.env, kept/);
  assert.match(second.stdout, /PROXY_SALT_KEY is already in .*cp\.env, kept/);
  assert.match(second.stdout, /PROXY_DB_PASSWORD is already in .*cp\.env, kept/);
});

test("an install beside an existing cp.env adds only its own three keys and touches no other line", async () => {
  // The case that really runs on the R750: cp.env has held the control plane's three secrets since
  // TENANT-1. Rewriting CP_SESSION_SECRET there would sign every customer out of every instance.
  const root = releaseTree();
  const log = path.join(tempTree(), "commands.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${stubBin(log)}:${process.env.PATH}`,
    TITANBOT_ROOT: root,
    TITANBOT_PROXY_ROOT: path.join(tempTree(), "titanbot-proxy"),
    TITANBOT_UID: String(process.getuid()),
    TITANBOT_GID: String(process.getgid()),
    TITANBOT_PROXY_DB_UID: String(process.getuid()),
    TITANBOT_PROXY_DB_GID: String(process.getgid()),
  };
  const cpEnv = path.join(root, "cp.env");
  const before = `CP_SESSION_SECRET=${randomBytes(32).toString("hex")}\nCP_ADMIN_TOKEN=${randomBytes(24).toString("hex")}\n`;
  writeFileSync(cpEnv, before, { mode: 0o600 });

  await run("bash", [INSTALL], { env });
  const after = readFileSync(cpEnv, "utf8");
  assert.ok(after.startsWith(before), "the lines that were already there are untouched and still first");
  assert.match(after, /^PROXY_MASTER_KEY=sk-[0-9a-f]{48}$/m);
});

test("--pin-url reads the alias docker actually gave the proxy rather than assuming the compose's", () => {
  // The design says it out loud: do not assume the alias from the compose service key. Coolify
  // renames the container, and the url the control plane is given has to be the name that resolves.
  const script = readFileSync(INSTALL, "utf8");
  assert.match(script, /docker ps --filter label=com\.titanbot\.role=proxy/);
  assert.match(script, /NetworkSettings\.Networks/);
  assert.match(script, /URL="http:\/\/\$ALIAS:\$PROXY_PORT\/v1"/, "with the /v1 postfix, which is what the control plane calls");
});

test("--pin-url writes CP_PROXY_URL once and never rewrites one that is already there", async () => {
  const root = releaseTree();
  const log = path.join(tempTree(), "commands.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${stubBin(log)}:${process.env.PATH}`,
    TITANBOT_ROOT: root,
    TITANBOT_PROXY_ROOT: path.join(tempTree(), "titanbot-proxy"),
  };
  const cpEnv = path.join(root, "cp.env");

  const first = await run("bash", [INSTALL, "--pin-url"], { env });
  assert.match(first.stdout, /alias\s+titanbot-proxy on titanbot-net/);
  assert.match(readFileSync(cpEnv, "utf8"), /^CP_PROXY_URL=http:\/\/titanbot-proxy:4000\/v1$/m);

  const second = await run("bash", [INSTALL, "--pin-url"], { env });
  assert.match(second.stdout, /CP_PROXY_URL is already in .*cp\.env, kept/);
  assert.equal(readFileSync(cpEnv, "utf8").split("CP_PROXY_URL=").length - 1, 1, "written once, not twice");
});

test("--pin-url stops by name when no proxy container is running, rather than pinning a guess", async () => {
  const root = releaseTree();
  const log = path.join(tempTree(), "commands.log");
  writeFileSync(log, "");
  const dir = path.join(tempTree(), "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await assert.rejects(
    run("bash", [INSTALL, "--pin-url"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TITANBOT_ROOT: root },
    }),
    (error) => {
      assert.match(String(error.stderr), /no running container carries com\.titanbot\.role=proxy/);
      return true;
    },
  );
});

// ---- the Coolify half ------------------------------------------------------------------------------

function fakeCoolify() {
  const calls = [];
  const state = { service: null, envs: new Map() };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      const url = new URL(request.url, "http://fake");
      const route = `${request.method} ${url.pathname}`;
      calls.push({ route, body, authorization: request.headers.authorization });
      const send = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (route === "GET /api/v1/projects") return send(200, [{ uuid: "proj-uuid", name: "Titanium Computing" }]);
      if (route === "GET /api/v1/projects/proj-uuid") {
        return send(200, { uuid: "proj-uuid", environments: [{ uuid: "env-uuid", name: "production" }] });
      }
      if (route === "GET /api/v1/services") return send(200, state.service ? [state.service] : []);
      if (route === "POST /api/v1/services") {
        state.service = { uuid: "svc-uuid", name: body.name };
        state.compose = body.docker_compose_raw;
        return send(201, { uuid: "svc-uuid" });
      }
      if (route === "PATCH /api/v1/services/svc-uuid") {
        if (body.docker_compose_raw) state.compose = body.docker_compose_raw;
        return send(200, { uuid: "svc-uuid" });
      }
      if (route === "GET /api/v1/services/svc-uuid/envs") {
        return send(200, [...state.envs].map(([key, value]) => ({ uuid: `env-${key}`, key, value })));
      }
      if (route === "POST /api/v1/services/svc-uuid/envs" || route === "PATCH /api/v1/services/svc-uuid/envs") {
        state.envs.set(body.key, body.value);
        return send(200, { uuid: `env-${body.key}`, is_literal: body.is_literal });
      }
      if (route === "POST /api/v1/services/svc-uuid/start") {
        state.started = (state.started ?? 0) + 1;
        return send(200, { message: "queued" });
      }
      return send(404, { message: `the fake Coolify has no ${route}` });
    });
  });
  return { server, calls, state };
}

async function listenOn(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// The operator's two files, as this test pretends they are. The names are the EXACT ones the script
// is allowed to read, and the file deliberately holds several others so a test that passed by
// scanning for anything key-shaped would fail here.
function operatorFiles({ withQwen = false, withTinyfish = false } = {}) {
  const dir = tempTree();
  const apiKeys = path.join(dir, "api_keys");
  const lines = [
    "# a comment",
    `ANTHROPIC_API_KEY=${randomBytes(20).toString("hex")}`,
    `ZAI_API_KEY=${FAKE_ZAI_1}`,
    `ZAI_API_KEY_JASON=${FAKE_ZAI_2}`,
    `MINIMAX_API_KEY=${FAKE_MINIMAX}`,
    `OPENAI_API_KEY=${randomBytes(20).toString("hex")}`,
  ];
  if (withQwen) lines.push(`QWEN_API_KEY=qwen-${randomBytes(16).toString("hex")}`);
  if (withTinyfish) lines.push(`TINYFISH_API_KEY=tf-${randomBytes(16).toString("hex")}`);
  writeFileSync(apiKeys, `${lines.join("\n")}\n`);

  const cpEnv = path.join(dir, "cp.env");
  writeFileSync(cpEnv, [
    `CP_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    `PROXY_MASTER_KEY=${FAKE_MASTER}`,
    `PROXY_SALT_KEY=${FAKE_SALT}`,
    `PROXY_DB_PASSWORD=${FAKE_DB_PASSWORD}`,
    "",
  ].join("\n"));
  return { apiKeys, cpEnv };
}

function toolEnv(url, files, extra = {}) {
  const log = path.join(tempTree(), "ssh.log");
  writeFileSync(log, "");
  return {
    ...process.env,
    PATH: `${stubBin(log, { cpEnvPath: files.cpEnv })}:${process.env.PATH}`,
    COOLIFY_URL: url,
    COOLIFY_API_KEY: FAKE_API_KEY,
    TITANBOT_API_KEYS: files.apiKeys,
    TITANBOT_CP_ENV: files.cpEnv,
    COOLIFY_PROJECT_UUID: "",
    COOLIFY_ENVIRONMENT_UUID: "",
    // Not set on purpose: these are what the script has to find for itself.
    PROXY_MASTER_KEY: "",
    PROXY_SALT_KEY: "",
    PROXY_DB_PASSWORD: "",
    PROXY_ZAI_KEY_1: "",
    PROXY_ZAI_KEY_2: "",
    PROXY_MINIMAX_KEY: "",
    PROXY_QWEN_KEY: "",
    PROXY_TINYFISH_KEY_1: "",
    PROXY_TINYFISH_KEY_2: "",
    ...extra,
  };
}

test("the Coolify tool's dry run prints the plan, calls nothing, and prints no key", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  const files = operatorFiles();
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL, "--dry-run"], { env: toolEnv(url, files) });
    assert.equal(fake.calls.length, 0, "a dry run must not call Coolify");
    assert.match(stdout, /dry run: nothing below is called/);
    assert.match(stdout, /titanbot-proxy in project Titanium Computing, environment production/);
    assert.match(stdout, /No port is published and no Domain is set/);
    // It never starts the service, and it says so: once the migration has run this is every tenant's
    // inference, and bringing it up is a decision an operator makes with their eyes on it.
    assert.match(stdout, /and then it STOPS\. No start, no restart, no deploy/);

    for (const value of [FAKE_MASTER, FAKE_SALT, FAKE_DB_PASSWORD, FAKE_ZAI_1, FAKE_ZAI_2, FAKE_MINIMAX, FAKE_API_KEY]) {
      assert.equal(stdout.includes(value), false, "a secret reached the terminal");
    }
    // Reported the way this project reports a key: name, length and hash prefix, never a value.
    assert.match(stdout, /PROXY_MASTER_KEY\s+\d+ characters, sha256 [0-9a-f]{12}/);
    assert.match(stdout, /PROXY_ZAI_KEY_1\s+from ZAI_API_KEY in api_keys, \d+ characters, sha256 [0-9a-f]{12}/);
  } finally { fake.server.close(); }
});

test("it names every provider key it could not find, and posts none of them empty", async () => {
  // Measured on this Mac 2026-09-08: ~/.api_keys holds ZAI_API_KEY, ZAI_API_KEY_JASON and
  // MINIMAX_API_KEY, and no Qwen or TinyFish name at all. An empty provider key would be a model
  // that starts cleanly and 401s on a customer's turn, which is the worst place to find out.
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  const files = operatorFiles();
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL], { env: toolEnv(url, files) });
    assert.match(stdout, /NOT FOUND, so these are not set on the service/);
    assert.match(stdout, /PROXY_QWEN_KEY \(looked for QWEN_API_KEY\)/);
    assert.match(stdout, /PROXY_TINYFISH_KEY_1 \(looked for TINYFISH_API_KEY\)/);
    assert.match(stdout, /Nothing was guessed at and no other file was read/);

    for (const name of ["PROXY_QWEN_KEY", "PROXY_TINYFISH_KEY_1", "PROXY_TINYFISH_KEY_2"]) {
      assert.equal(fake.state.envs.has(name), false, `${name} was posted with nothing behind it`);
    }
    assert.equal(fake.state.envs.get("PROXY_ZAI_KEY_1"), FAKE_ZAI_1);
    assert.equal(fake.state.envs.get("PROXY_ZAI_KEY_2"), FAKE_ZAI_2);
    assert.equal(fake.state.envs.get("PROXY_MINIMAX_KEY"), FAKE_MINIMAX);
  } finally { fake.server.close(); }
});

test("a key can come from the shell under its PROXY_ name, so one that lives elsewhere gets in without a hunt", async () => {
  // TinyFish's key is not in ~/.api_keys and this script is not allowed to go looking for it. The
  // operator supplies it themselves, by name, and nothing here reads another file.
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  const files = operatorFiles();
  const supplied = `tf-${randomBytes(16).toString("hex")}`;
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL], {
      env: toolEnv(url, files, { PROXY_TINYFISH_KEY_1: supplied }),
    });
    assert.equal(fake.state.envs.get("PROXY_TINYFISH_KEY_1"), supplied);
    assert.match(stdout, /PROXY_TINYFISH_KEY_1\s+from your shell/);
    assert.equal(stdout.includes(supplied), false);
  } finally { fake.server.close(); }
});

test("it creates the service, sets the environment as literals, and never starts it", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  const files = operatorFiles();
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL], { env: toolEnv(url, files) });

    const created = fake.calls.find((call) => call.route === "POST /api/v1/services").body;
    assert.equal(created.name, "titanbot-proxy");
    assert.equal(created.project_uuid, "proj-uuid");
    assert.equal(created.environment_uuid, "env-uuid");
    assert.equal(created.server_uuid, "zl2ti5llrtpx83918j8arb9f", "the R750");
    assert.equal(created.instant_deploy, false);
    assert.equal(
      Buffer.from(created.docker_compose_raw, "base64").toString("utf8"),
      composeText,
      "the compose Coolify gets is byte for byte the file in the repo",
    );

    // The three secrets, read off the server rather than carried in a shell.
    assert.equal(fake.state.envs.get("PROXY_MASTER_KEY"), FAKE_MASTER);
    assert.equal(fake.state.envs.get("PROXY_SALT_KEY"), FAKE_SALT);
    assert.equal(fake.state.envs.get("PROXY_DB_PASSWORD"), FAKE_DB_PASSWORD);
    // And the url assembled from one of them, which is why the compose does not interpolate it.
    assert.equal(
      fake.state.envs.get("PROXY_DATABASE_URL"),
      `postgresql://litellm:${FAKE_DB_PASSWORD}@titanbot-proxy-db:5432/litellm`,
    );
    // The literals in the file come through unchanged. STORE_MODEL_IN_DB is True as of PROVIDERS-1:
    // providers, keys and plan models are database rows managed from the panel, and config.yaml is
    // the bootstrap for what has to be read before there is a database to read.
    assert.equal(fake.state.envs.get("STORE_MODEL_IN_DB"), "True");
    assert.equal(fake.state.envs.get("LITELLM_MODE"), "PRODUCTION");
    assert.equal(fake.state.envs.get("LITELLM_LOG"), "ERROR");
    // A reference is posted under the name INSIDE the braces, which is the field Coolify's parser
    // makes. Posting it under the key on the left would set a field the compose never reads.
    assert.equal(fake.state.envs.has("LITELLM_MASTER_KEY"), false, "the field is named by the braces, not by the key");

    // is_literal, because a generated secret has to reach the container byte for byte and Coolify
    // escapes $ in a value that is not marked literal.
    for (const call of fake.calls.filter((one) => one.route.endsWith("/envs") && one.route.startsWith("POST"))) {
      assert.equal(call.body.is_literal, true, `${call.body.key} was not sent as a literal`);
    }

    assert.equal(fake.state.started, undefined, "it must never start the service by itself");
    assert.equal(fake.calls.some((call) => /\/(start|restart|deploy)$/.test(call.route)), false);
    assert.match(stdout, /done, and NOT started/);
    for (const call of fake.calls) assert.equal(call.authorization, `Bearer ${FAKE_API_KEY}`);
  } finally { fake.server.close(); }
});

test("a second run updates rather than duplicating, and is quiet about it", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  const files = operatorFiles();
  try {
    await run("node", [COOLIFY_TOOL], { env: toolEnv(url, files) });
    const afterFirst = fake.calls.length;
    const { stdout } = await run("node", [COOLIFY_TOOL], { env: toolEnv(url, files) });
    const second = fake.calls.slice(afterFirst).map((call) => call.route);
    assert.equal(second.filter((route) => route === "POST /api/v1/services").length, 0, "it must never create a second service");
    assert.match(stdout, /found titanbot-proxy at svc-uuid/);
    assert.match(stdout, /0 added, 0 corrected, \d+ already right/);

    // And a changed value is corrected, not added twice.
    fake.state.envs.set("LITELLM_LOG", "DEBUG");
    const third = await run("node", [COOLIFY_TOOL], { env: toolEnv(url, files) });
    assert.match(third.stdout, /0 added, 1 corrected, \d+ already right/);
    assert.equal(fake.state.envs.get("LITELLM_LOG"), "ERROR");
  } finally { fake.server.close(); }
});

test("it stops before creating anything when the installer's secrets are not there", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  const files = operatorFiles();
  // cp.env without the three, which is the shape of a server where proxy-install.sh has not run.
  writeFileSync(files.cpEnv, `CP_SESSION_SECRET=${randomBytes(32).toString("hex")}\n`);
  try {
    await assert.rejects(run("node", [COOLIFY_TOOL], { env: toolEnv(url, files) }), (error) => {
      assert.equal(error.code, 2, "exit 2 is the environment, not a failed call");
      assert.match(String(error.stderr), /the proxy cannot run without them: PROXY_MASTER_KEY/);
      assert.match(String(error.stderr), /proxy-install\.sh/);
      return true;
    });
    assert.equal(fake.calls.filter((call) => call.route.startsWith("POST")).length, 0, "nothing was created");
  } finally { fake.server.close(); }
});

test("sync.sh will not build a standalone relay on a server already running the Coolify fleet", () => {
  // Measured on the R750 2026-09-08: a plain sync.sh created titanbot-relay and titanbot-box beside
  // the three live customer boxes, because install.sh builds a standalone instance and sync.sh ran
  // it by default. Nothing live broke, but a second thing called a relay was left restarting.
  const sync = readFileSync(SYNC, "utf8");
  assert.match(sync, /titanbot-relay-\[a-z0-9\]\+/, "sync.sh does not look for a Coolify-managed relay");
  // The guard must come BEFORE the install call, or it guards nothing.
  const guardAt = sync.indexOf("titanbot-relay-[a-z0-9]+");
  const installAt = sync.lastIndexOf("deploy/install.sh'\"");
  assert.ok(guardAt > 0 && installAt > guardAt, "the guard must be ahead of the install call");
  // And it must still be possible on purpose, so a fresh server is not locked out of install.sh.
  assert.match(sync, /to build a standalone instance here anyway/);
});
