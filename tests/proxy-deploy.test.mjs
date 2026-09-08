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

test("the config file it mounts holds no key at all, only os.environ references", () => {
  // This is why config.yaml can live in git and sit readable in the bind mount, and it is the
  // difference between this design and the box-secrets.json copies it replaces.
  const configText = readFileSync(CONFIG, "utf8");
  const apiKeys = [...configText.matchAll(/^\s*api_key:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(apiKeys.length >= 3, `expected the model keys, found ${apiKeys.length}`);
  for (const value of apiKeys) assert.match(value, /^os\.environ\/[A-Z0-9_]+$/, `${value} is a literal key in a file in git`);
  // And every name it refers to is one the compose supplies, or the container gets a model with no
  // credential that 401s on a customer's turn.
  const referenced = new Set([...configText.matchAll(/os\.environ\/([A-Z0-9_]+)/g)]
    .filter((m) => !/^\s*#/.test(configText.slice(configText.lastIndexOf("\n", m.index) + 1, m.index)))
    .map((m) => m[1]));
  for (const name of referenced) {
    assert.ok(composeCode.includes(`${name}: \${${name}}`), `config.yaml wants ${name} and the compose does not supply it`);
  }
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
  // And no address is hard-coded anywhere in the file.
  const literals = [...script.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `an address is written into the script: ${literals.join(", ")}`);
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

// A release tree with the one file the installer insists on before it will make anything.
function releaseTree() {
  const root = path.join(tempTree(), "titanbot");
  mkdirSync(path.join(root, "deploy/coolify/proxy-config"), { recursive: true });
  writeFileSync(path.join(root, "deploy/coolify/proxy-config/config.yaml"), readFileSync(CONFIG, "utf8"));
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
  assert.match(first.stdout, /and serves these model names.*plan-minimax plan-zai/);

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
    // The literals in the file come through unchanged.
    assert.equal(fake.state.envs.get("STORE_MODEL_IN_DB"), "False");
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
