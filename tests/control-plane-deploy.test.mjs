// TENANT-2, item 6. The two halves of the control plane deploy, held to being repeatable.
//
// deploy/r750/control-plane-install.sh runs on the R750 and makes the tenant root, the image and
// the two secrets. deploy/r750/control-plane-coolify.mjs runs on the Mac and makes the Coolify
// service. Both replace steps that used to be done by hand on a live server, and the thing worth
// testing about both is the thing hand steps never had: they can be run twice.
//
// Nothing here touches a real server, a real Coolify or a real docker. The install script runs with
// `sudo` and `docker` replaced by recorders on PATH, so its real commands are read back out of a
// log rather than executed, and the Coolify tool runs against an http server in this process that
// answers the way the openapi says.
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

import { OPTIONAL_KEYS } from "../deploy/r750/control-plane-coolify.mjs";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(repo, "deploy/r750/control-plane-install.sh");
const COOLIFY_TOOL = path.join(repo, "deploy/r750/control-plane-coolify.mjs");
const COMPOSE = path.join(repo, "deploy/coolify/control-plane.compose.yml");

// Fake, generated here, and the length of the real ones so the "not printed" lines are measuring
// something the same shape.
const FAKE_SESSION_SECRET = randomBytes(32).toString("hex");
const FAKE_ADMIN_TOKEN = randomBytes(24).toString("hex");
const FAKE_RELAY_TOKEN = randomBytes(32).toString("hex");
const FAKE_API_KEY = `${randomBytes(24).toString("base64url")}|fake`;
// PROXY-1. sk- prefixed, the shape deploy/r750/proxy-install.sh generates, because half of
// LiteLLM's own tooling and error messages assume it.
const FAKE_PROXY_MASTER_KEY = `sk-${randomBytes(24).toString("hex")}`;
const temps = [];
function tempTree() {
  const root = mkdtempSync(path.join(tmpdir(), "cp-deploy-"));
  temps.push(root);
  return root;
}
test.after(() => { for (const one of temps) rmSync(one, { recursive: true, force: true }); });

// A release tree with the files the install script insists on before it will build anything.
// box.compose.yml is in the list as of TENANT-5: it is the template every tenant is rendered from,
// and an image built without it fails on the compose step of the first customer rather than at
// build time.
const REQUIRED_IN_THE_BUILD_CONTEXT = [
  "cp/Dockerfile", "cp/server.mjs", "ui/auth.mjs", "ui/set-password.mjs",
  "deploy/coolify/docker-compose.yml", "deploy/coolify/box.compose.yml",
];
function releaseTree() {
  const root = path.join(tempTree(), "titanbot");
  for (const dir of ["cp", "ui", "deploy/coolify"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of REQUIRED_IN_THE_BUILD_CONTEXT) writeFileSync(path.join(root, file), "# stand-in\n");
  return root;
}

// `sudo` and `docker` replaced by a recorder. Everything the script would have done to this machine
// lands in a log file instead, which is also how the arguments are read back below.
function stubBin(logPath) {
  const dir = path.join(tempTree(), "bin");
  mkdirSync(dir, { recursive: true });
  for (const name of ["sudo", "docker"]) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${logPath}"\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

test("the install script's dry run prints every command and changes nothing", async () => {
  const root = releaseTree();
  const tenants = path.join(tempTree(), "titanbot-data");
  const { stdout } = await run("bash", [INSTALL], {
    env: {
      ...process.env,
      TITANBOT_DRY_RUN: "1",
      TITANBOT_ROOT: root,
      TITANBOT_TENANT_ROOT: tenants,
      TITANBOT_UID: "1001",
      TITANBOT_GID: "1001",
    },
  });

  assert.match(stdout, /dry run: nothing below is executed/);
  // The uid is the fact this whole item turned on: sem on the R750 is 1001, not the 1000 the
  // Dockerfile used to assume, and the directory and the image have to agree on it.
  assert.match(stdout, new RegExp(`would run: sudo install -d -o 1001 -g 1001 -m 0750 ${tenants}$`, "m"));
  assert.match(stdout, new RegExp(`would run: sudo install -d -o 1001 -g 1001 -m 0750 ${tenants}/_control-plane$`, "m"));
  assert.match(stdout, /would run: docker build -t titanbot-cp:local .* --build-arg UID=1001 --build-arg GID=1001/);
  assert.match(stdout, /would create .*cp\.env at mode 0600/);

  // And it is a rehearsal, not a run.
  assert.throws(() => statSync(tenants), /ENOENT/, "a dry run must not make the tenant root");
  assert.throws(() => statSync(path.join(root, "cp.env")), /ENOENT/, "a dry run must not write cp.env");
});

test("the install script refuses to run as root, because everything it makes would be root-owned", async () => {
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

test("the install script names the missing file rather than failing inside a docker build", async () => {
  const root = releaseTree();
  rmSync(path.join(root, "ui/auth.mjs"));
  await assert.rejects(
    run("bash", [INSTALL], { env: { ...process.env, TITANBOT_DRY_RUN: "1", TITANBOT_ROOT: root, TITANBOT_UID: "1001", TITANBOT_GID: "1001" } }),
    (error) => {
      assert.match(String(error.stderr), /ui\/auth\.mjs is missing -- run deploy\/r750\/sync\.sh from the Mac/);
      return true;
    },
  );
});

test("a real install generates the three secrets once and a second run keeps them", async () => {
  const root = releaseTree();
  const tenants = path.join(tempTree(), "titanbot-data");
  const log = path.join(tempTree(), "commands.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${stubBin(log)}:${process.env.PATH}`,
    TITANBOT_ROOT: root,
    TITANBOT_TENANT_ROOT: tenants,
    TITANBOT_UID: "1001",
    TITANBOT_GID: "1001",
  };

  const first = await run("bash", [INSTALL], { env });
  const cpEnv = path.join(root, "cp.env");

  // 0600, because the master session secret is in it. Anything readable by another account here is
  // every customer's session signed by anyone who can read this file.
  assert.equal(statSync(cpEnv).mode & 0o777, 0o600, "cp.env is readable by its owner only");
  const written = readFileSync(cpEnv, "utf8");
  const sessionSecret = /^CP_SESSION_SECRET=(.+)$/m.exec(written)?.[1];
  const adminToken = /^CP_ADMIN_TOKEN=(.+)$/m.exec(written)?.[1];
  // TENANT-5. The console relay's own bearer, generated here beside the other two because it is
  // the third thing the relay and this service have to agree on.
  const relayToken = /^CP_RELAY_TOKEN=(.+)$/m.exec(written)?.[1];
  assert.match(String(sessionSecret), /^[0-9a-f]{64}$/, "32 bytes as hex");
  assert.match(String(adminToken), /^[0-9a-f]{48}$/, "24 bytes as hex");
  assert.match(String(relayToken), /^[0-9a-f]{64}$/, "32 bytes as hex, which is the floor the service refuses to start below");
  assert.notEqual(relayToken, adminToken, "two doors, and neither holds the other's key");
  assert.notEqual(relayToken, sessionSecret);

  // None of them is ever printed, on either run.
  assert.equal(first.stdout.includes(sessionSecret), false, "the session secret is not printed");
  assert.equal(first.stdout.includes(adminToken), false, "the admin token is not printed");
  assert.equal(first.stdout.includes(relayToken), false, "the relay token is not printed");

  // What it actually ran.
  const commands = readFileSync(log, "utf8");
  assert.match(commands, new RegExp(`^sudo install -d -o 1001 -g 1001 -m 0750 ${tenants}$`, "m"));
  assert.match(commands, new RegExp(`^sudo install -d -o 1001 -g 1001 -m 0750 ${tenants}/_control-plane$`, "m"));
  assert.match(commands, /^docker build -t titanbot-cp:local .*--build-arg UID=1001 --build-arg GID=1001 /m);

  // The second run. A new master here would sign sessions no tenant relay would accept, because
  // every relay is already holding a key derived from the first one.
  const second = await run("bash", [INSTALL], { env });
  assert.equal(readFileSync(cpEnv, "utf8"), written, "cp.env is byte for byte what the first run left");
  assert.match(second.stdout, /CP_SESSION_SECRET is already in .*cp\.env, kept/);
  assert.match(second.stdout, /CP_ADMIN_TOKEN is already in .*cp\.env, kept/);
  assert.match(second.stdout, /CP_RELAY_TOKEN is already in .*cp\.env, kept/);
  assert.equal(second.stdout.includes(sessionSecret), false, "still not printed on a second run");
});

test("an install that predates the relay token adds only that, and keeps the master it already had", async () => {
  // The case that really runs on the R750: cp.env has been there since TENANT-1 with the two
  // secrets in it, and the third is new. Minting a second master here would sign every customer out
  // of every instance at once, so the test is as much about what is kept as about what is added.
  const root = releaseTree();
  const log = path.join(tempTree(), "commands.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${stubBin(log)}:${process.env.PATH}`,
    TITANBOT_ROOT: root,
    TITANBOT_TENANT_ROOT: path.join(tempTree(), "titanbot-data"),
    TITANBOT_UID: "1001",
    TITANBOT_GID: "1001",
  };
  const cpEnv = path.join(root, "cp.env");
  writeFileSync(cpEnv, `CP_SESSION_SECRET=${FAKE_SESSION_SECRET}\nCP_ADMIN_TOKEN=${FAKE_ADMIN_TOKEN}\n`, { mode: 0o600 });

  const { stdout } = await run("bash", [INSTALL], { env });
  const written = readFileSync(cpEnv, "utf8");
  assert.equal(/^CP_SESSION_SECRET=(.+)$/m.exec(written)[1], FAKE_SESSION_SECRET, "the master is untouched");
  assert.equal(/^CP_ADMIN_TOKEN=(.+)$/m.exec(written)[1], FAKE_ADMIN_TOKEN);
  assert.match(/^CP_RELAY_TOKEN=(.+)$/m.exec(written)[1], /^[0-9a-f]{64}$/, "and the new one is there");
  assert.match(stdout, /CP_RELAY_TOKEN generated/);
  assert.equal(stdout.includes(FAKE_SESSION_SECRET), false);
});

// ---- the Coolify half ---------------------------------------------------------------------------

// Coolify, as far as this tool can tell. It records every call and keeps enough state that the
// second run of the tool sees a service that already exists.
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
        return send(200, { uuid: "proj-uuid", name: "Titanium Computing", environments: [{ uuid: "env-uuid", name: "production" }] });
      }
      if (route === "GET /api/v1/services") return send(200, state.service ? [state.service] : []);
      if (route === "POST /api/v1/services") {
        state.service = { uuid: "svc-uuid", name: body.name };
        state.compose = body.docker_compose_raw;
        return send(201, { uuid: "svc-uuid", domains: [] });
      }
      if (route === "PATCH /api/v1/services/svc-uuid") {
        if (body.docker_compose_raw) state.compose = body.docker_compose_raw;
        if (body.urls) state.urls = body.urls;
        return send(200, { uuid: "svc-uuid", domains: [] });
      }
      if (route === "GET /api/v1/services/svc-uuid/envs") {
        return send(200, [...state.envs].map(([key, value]) => ({ uuid: `env-${key}`, key, value })));
      }
      if (route === "POST /api/v1/services/svc-uuid/envs") {
        state.envs.set(body.key, body.value);
        return send(201, { uuid: `env-${body.key}` });
      }
      if (route === "PATCH /api/v1/services/svc-uuid/envs") {
        state.envs.set(body.key, body.value);
        return send(200, { uuid: `env-${body.key}` });
      }
      if (route === "POST /api/v1/services/svc-uuid/start") {
        state.started = (state.started ?? 0) + 1;
        return send(200, { message: "Service starting request queued." });
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

const toolEnv = (url) => ({
  ...process.env,
  COOLIFY_URL: url,
  COOLIFY_API_KEY: FAKE_API_KEY,
  CP_SESSION_SECRET: FAKE_SESSION_SECRET,
  CP_ADMIN_TOKEN: FAKE_ADMIN_TOKEN,
  // TENANT-5. The console relay's own bearer, and the only thing that opens the route that hands
  // it every customer's gateway token.
  CP_RELAY_TOKEN: FAKE_RELAY_TOKEN,
  // Off, which is the shape the product is in: the operator adds a customer from the CLI.
  CP_ALLOW_SIGNUP: "0",
  // The server's own outbound address: every customer's sign-in reaches the control plane from it,
  // so the address half of its lockout has to know which caller is a relay and which is a person.
  CP_RELAY_PEERS: "203.0.113.7/32",
  // Not set on purpose: COOLIFY_PROJECT_UUID and COOLIFY_ENVIRONMENT_UUID are the two the tool has
  // to find for itself, which is the point of resolving the project by its name.
  COOLIFY_PROJECT_UUID: "",
  COOLIFY_ENVIRONMENT_UUID: "",
});

test("the Coolify tool's dry run prints the plan and reaches Coolify not at all", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL, "--dry-run"], { env: toolEnv(url) });
    assert.equal(fake.calls.length, 0, "a dry run must not call Coolify");

    assert.match(stdout, /dry run: nothing below is called/);
    assert.match(stdout, /nothing was called\. Run it again without --dry-run\./);
    assert.match(stdout, /titanbot-cp in project Titanium Computing, environment production/);
    assert.match(stdout, /urls\[\{name: titanbot-cp, url: https:\/\/api\.titanium\.bot:7790\}\]/);

    // And the plan is safe to paste into a ticket, which is the only reason to print one.
    for (const secret of [FAKE_SESSION_SECRET, FAKE_ADMIN_TOKEN, FAKE_RELAY_TOKEN, FAKE_API_KEY]) {
      assert.equal(stdout.includes(secret), false, "a secret reached the terminal");
    }
    assert.match(stdout, /CP_SESSION_SECRET\s+\(set, 64 characters, not printed\)/);
    assert.match(stdout, /CP_ADMIN_TOKEN\s+\(set, 48 characters, not printed\)/);
    assert.match(stdout, /CP_RELAY_TOKEN\s+\(set, 64 characters, not printed\)/);
  } finally { fake.server.close(); }
});

test("the Coolify tool creates the service, sets the environment, sets the address and starts it", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL], { env: toolEnv(url) });

    const routes = fake.calls.map((call) => call.route);
    assert.deepEqual(routes.slice(0, 4), [
      "GET /api/v1/projects",
      "GET /api/v1/projects/proj-uuid",
      "GET /api/v1/services",
      "POST /api/v1/services",
    ], "it finds the project by name, then the environment, then looks before it creates");

    // The service, as Coolify was asked to make it.
    const created = fake.calls.find((call) => call.route === "POST /api/v1/services").body;
    assert.equal(created.name, "titanbot-cp");
    assert.equal(created.project_uuid, "proj-uuid");
    assert.equal(created.environment_name, "production");
    assert.equal(created.environment_uuid, "env-uuid");
    assert.equal(created.server_uuid, "zl2ti5llrtpx83918j8arb9f", "the R750");
    assert.equal(created.instant_deploy, false, "the start is a step of its own, after the environment is set");
    assert.equal(
      Buffer.from(created.docker_compose_raw, "base64").toString("utf8"),
      readFileSync(COMPOSE, "utf8"),
      "the compose Coolify gets is byte for byte the file in the repo",
    );

    // The environment. Every key the compose names, plus the environment uuid, and the two
    // deliberate differences from the file.
    const composeKeys = [...readFileSync(COMPOSE, "utf8").matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    assert.ok(composeKeys.length >= 16, `the compose names ${composeKeys.length} environment keys`);
    // PROXY-1. Four of them are OPTIONAL, and this run does not set them: unset is the proxy feature
    // switched off, which is the shape every install is in until the proxy has been stood up. They
    // get a test of their own below, in both directions.
    for (const key of composeKeys) {
      if (OPTIONAL_KEYS.has(key)) {
        assert.equal(fake.state.envs.has(key), false, `${key} is optional and nothing supplied it, so it must not be written`);
        continue;
      }
      assert.ok(fake.state.envs.has(key), `${key} was not set on the service`);
    }
    assert.equal(fake.state.envs.get("COOLIFY_ENVIRONMENT_UUID"), "env-uuid", "the uuid the compose does not carry");
    assert.equal(fake.state.envs.get("CP_ALLOW_NEW_TENANTS"), "1", "on, because this is the operator standing it up");
    assert.equal(fake.state.envs.get("CP_SESSION_SECRET"), FAKE_SESSION_SECRET);
    assert.equal(fake.state.envs.get("CP_ADMIN_TOKEN"), FAKE_ADMIN_TOKEN);
    // TENANT-5. Without this the one relay cannot read the registry and every customer's console
    // answers "that workspace is not available right now", so the deploy has to carry it.
    assert.equal(fake.state.envs.get("CP_RELAY_TOKEN"), FAKE_RELAY_TOKEN);
    assert.equal(fake.state.envs.get("CP_CONSOLE_HOST"), "console.titanium.bot");
    assert.equal(fake.state.envs.get("CP_SHARED_NETWORK"), "titanbot-net");
    assert.equal(fake.state.envs.get("COOLIFY_PROJECT_UUID"), "proj-uuid", "resolved, not carried in a shell");
    assert.equal(fake.state.envs.get("COOLIFY_SERVER_UUID"), "zl2ti5llrtpx83918j8arb9f");
    assert.equal(fake.state.envs.get("CP_TENANT_ROOT"), "/data/titanbot");
    assert.equal(fake.state.envs.get("CP_RELEASE_ROOT"), "/home/sem/titanbot");
    assert.equal(fake.state.envs.get("CP_BASE_DOMAIN"), "titanium.bot");
    assert.equal(fake.state.envs.get("CP_PUBLIC_URL"), "https://api.titanium.bot");
    assert.match(fake.state.envs.get("CP_CLOUDFLARE_RANGES"), /^173\.245\.48\.0\/20,/);
    assert.match(fake.state.envs.get("CP_TRUSTED_PROXIES"), /^10\.0\.0\.0\/8,/);
    // Without this the login lockout counts every customer on every instance in one bucket, because
    // every sign-in in the fleet reaches the control plane from this one address.
    assert.equal(fake.state.envs.get("CP_RELAY_PEERS"), "203.0.113.7/32");

    // A generated secret has to reach the container byte for byte, and Coolify escapes $ in a value
    // that is not marked literal.
    for (const call of fake.calls.filter((one) => one.route.endsWith("/envs") && one.route !== "GET /api/v1/services/svc-uuid/envs")) {
      assert.equal(call.body.is_literal, true, `${call.body.key} was not sent as a literal`);
    }

    // The address, on the compose's service name rather than the Coolify resource name.
    assert.deepEqual(fake.state.urls, [{ name: "titanbot-cp", url: "https://api.titanium.bot:7790" }]);
    assert.equal(fake.state.started, 1, "started once, at the end");
    assert.equal(routes.at(-1), "POST /api/v1/services/svc-uuid/start", "the start is the last thing it does");

    // The bearer went in the one header and nowhere else.
    for (const call of fake.calls) assert.equal(call.authorization, `Bearer ${FAKE_API_KEY}`);
    for (const secret of [FAKE_SESSION_SECRET, FAKE_ADMIN_TOKEN, FAKE_API_KEY, url]) {
      assert.equal(stdout.includes(secret), false, "a secret reached the terminal");
    }
    assert.match(stdout, /25 added, 0 corrected, 0 already right/);
  } finally { fake.server.close(); }
});

test("a second run of the Coolify tool updates rather than duplicating, and is quiet about it", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  try {
    await run("node", [COOLIFY_TOOL], { env: toolEnv(url) });
    const afterFirst = fake.calls.length;

    const { stdout } = await run("node", [COOLIFY_TOOL], { env: toolEnv(url) });
    const second = fake.calls.slice(afterFirst).map((call) => call.route);

    assert.equal(second.filter((route) => route === "POST /api/v1/services").length, 0, "it must never create a second service");
    assert.match(stdout, /found titanbot-cp at svc-uuid/);
    assert.match(stdout, /0 added, 0 corrected, 25 already right/, "nothing changed, so nothing was written");
    assert.equal(fake.state.started, 2, "it still starts, because a start on a running service is how a redeploy happens");

    // And a changed value is corrected, not added twice.
    fake.state.envs.set("CP_BASE_DOMAIN", "wrong.example");
    const third = await run("node", [COOLIFY_TOOL], { env: toolEnv(url) });
    assert.match(third.stdout, /0 added, 1 corrected, 24 already right/);
    assert.equal(fake.state.envs.get("CP_BASE_DOMAIN"), "titanium.bot");
  } finally { fake.server.close(); }
});

// PROXY-1. The control plane learns about the proxy through two values, and the whole design rests
// on BOTH shapes working: with them, it mints a virtual key per tenant; without them, every surface
// behaves exactly as it did before this wave. Making them required would have been the easy thing
// and would stop the control plane deploying for every existing customer, Jason's own console
// included, the moment somebody forgot one.
test("the proxy keys are optional, and unset means the feature is off rather than a failed deploy", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  try {
    const { stdout } = await run("node", [COOLIFY_TOOL], { env: toolEnv(url) });
    for (const key of OPTIONAL_KEYS) {
      assert.equal(fake.state.envs.has(key), false, `${key} was not supplied, so nothing should have been written`);
    }
    assert.match(stdout, /not set, so the proxy feature stays off: CP_PROXY_URL/);
    // And the deploy still happened, which is the whole point.
    assert.equal(fake.state.started, 1);
  } finally { fake.server.close(); }
});

test("and set, they reach the service, with the master key never printed", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  try {
    const env = {
      ...toolEnv(url),
      CP_PROXY_URL: "http://titanbot-proxy:4000/v1",
      CP_PROXY_MASTER_KEY: FAKE_PROXY_MASTER_KEY,
      CP_PROXY_ALLOWANCE_USD: "25",
    };
    const { stdout } = await run("node", [COOLIFY_TOOL], { env });
    assert.equal(fake.state.envs.get("CP_PROXY_URL"), "http://titanbot-proxy:4000/v1");
    assert.equal(fake.state.envs.get("CP_PROXY_MASTER_KEY"), FAKE_PROXY_MASTER_KEY);
    assert.equal(fake.state.envs.get("CP_PROXY_ALLOWANCE_USD"), "25");
    // Still off, because enforcement is a separate switch and this wave observes rather than stops.
    assert.equal(fake.state.envs.has("CP_PROXY_ENFORCE"), false);

    // The master key opens /key/generate on the proxy, which is every tenant's budget and every
    // tenant's key in one string. It is a secret and it is printed by length only.
    assert.equal(stdout.includes(FAKE_PROXY_MASTER_KEY), false, "the proxy master key reached the terminal");
    assert.match(stdout, /CP_PROXY_MASTER_KEY\s+\(set, \d+ characters, not printed\)/);
    // The url is not a secret and is printed, because an operator checking the plan has to see it.
    assert.match(stdout, /CP_PROXY_URL\s+http:\/\/titanbot-proxy:4000\/v1/);
  } finally { fake.server.close(); }
});

test("the Coolify tool stops by name when a secret is not in the shell, before it creates anything", async () => {
  const fake = fakeCoolify();
  const url = await listenOn(fake.server);
  try {
    const env = toolEnv(url);
    delete env.CP_SESSION_SECRET;
    await assert.rejects(run("node", [COOLIFY_TOOL], { env }), (error) => {
      assert.equal(error.code, 2, "exit 2 is the environment, not a failed call");
      assert.match(String(error.stderr), /these are not set in your shell and the compose expects them: CP_SESSION_SECRET/);
      assert.match(String(error.stderr), /cp\.env on the R750/);
      // The new one has to name itself and say where the value comes from, because an operator who
      // does not set it gets a fleet-wide lockout rather than an error.
      assert.match(String(error.stderr), /CP_RELAY_PEERS/);
      assert.match(String(error.stderr), /api\.ipify\.org/);
      return true;
    });
    assert.equal(fake.calls.filter((call) => call.route.startsWith("POST")).length, 0, "nothing was created");
  } finally { fake.server.close(); }
});

// The image and the directory have to agree on the uid or the control plane cannot write the
// directories it just made. This is the pair, read out of both files rather than restated here.
test("the Dockerfile takes the uid as a build argument and defaults to sem on the R750", () => {
  const dockerfile = readFileSync(path.join(repo, "cp/Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG UID=1001$/m, "sem on the R750 is 1001, measured, not assumed");
  assert.match(dockerfile, /^ARG GID=1001$/m);
  assert.match(dockerfile, /^USER \$\{UID\}:\$\{GID\}$/m, "numeric, so the host's uid is the point rather than a name in the image");
  assert.equal(/^USER node$/m.test(dockerfile), false, "USER node is uid 1000 in this base image, which is not sem here");

  const script = readFileSync(INSTALL, "utf8");
  assert.match(script, /--build-arg "UID=\$UID_WANT" --build-arg "GID=\$GID_WANT"/, "the build is given the same pair the directory is owned by");
  assert.match(script, /install -d -o "\$UID_WANT" -g "\$GID_WANT" -m 0750/);
});

// TENANT-5. The template every customer is rendered from is a file, and three separate things have
// to agree that it exists: the Dockerfile copies it into the image, sync.sh puts it on the server so
// the build context has it, and the install script checks for it by name before it builds. Miss any
// one and the image builds cleanly and then fails on the compose step of the first customer, which
// is the worst time to find out.
test("the box template travels with the control plane, in all three places", () => {
  const dockerfile = readFileSync(path.join(repo, "cp/Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY deploy\/coolify\/box\.compose\.yml \/app\/deploy\/coolify\/box\.compose\.yml$/m);

  const sync = readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8").replace(/\\\n\s*/g, " ");
  const shipped = [...sync.matchAll(/^rsync .*$/gm)].map((m) => m[0]).join("\n");
  assert.match(shipped, /deploy\/coolify\/box\.compose\.yml/);

  assert.match(readFileSync(INSTALL, "utf8"), /deploy\/coolify\/box\.compose\.yml/);

  // And the file itself is what the renderer expects to find: one service, the shared network
  // declared external, and the two places the tenant's name is written.
  const template = readFileSync(path.join(repo, "deploy/coolify/box.compose.yml"), "utf8");
  const services = template.split(/^services:$/m)[1].split(/^\S/m)[0];
  assert.deepEqual(services.match(/^ {2}\S+:$/gm), ["  titanbot-box:"]);
  assert.match(template, /^ {2}titanbot-net:\n {4}external: true\n {4}name: titanbot-net$/m);
  assert.equal(template.split("TENANT_SLUG").length - 1, 2);
  assert.equal(/^\s*ports:/m.test(template), false, "a customer's box is never on a server port");
  assert.equal(/docker\.sock/.test(template), false, "and never holds the host's docker socket");
});

test("sync.sh puts the install script on the server, because that is where it runs", () => {
  const sync = readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8");
  // Continuations joined first: the rsync that ships the deploy scripts is three lines long, and a
  // per-line grep would read only the first of them.
  const flattened = sync.replace(/\\\n\s*/g, " ");
  const shipped = [...flattened.matchAll(/^rsync .*$/gm)].map((m) => m[0]).join("\n");
  assert.match(shipped, /control-plane-install\.sh/, "it runs on the R750, so it has to be shipped there");
  assert.equal(
    /control-plane-coolify\.mjs/.test(shipped),
    false,
    "the Coolify half runs from the Mac and holds the api key while it runs; it does not belong on the server",
  );
});
