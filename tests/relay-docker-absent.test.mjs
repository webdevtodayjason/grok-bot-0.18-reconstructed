// TENANT-2 item 4: a relay with no docker.
//
// A customer's instance is rendered without /var/run/docker.sock, because that socket is root on
// the host. Everything in ui/server.mjs that reaches the box through `docker exec` therefore
// reaches nothing, and the old behaviour was the bad kind of failure: dockerOut swallows ENOENT
// and resolves null, so the model picker answered 200 with every field null, the connectors editor
// answered 503 on every console load, and /box/launch answered 200 for a window that was never
// coming. All three read as "this console is broken".
//
// Two halves here. First the probe on its own, with a fake execFile, because "probes once and
// remembers" is a claim about how many times it shells out and nothing else can see that. Then the
// routes, on a real relay listening on a real port with a PATH that has no docker on it: the
// refusals have to be what a caller actually receives, not what a helper returns.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NOT_AVAILABLE, createDockerProbe, notAvailable } from "../ui/docker-edge.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the probe ------------------------------------------------------------------------------

// A fake execFile that records every call and answers from a script.
function fakeExec(answer) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    const reply = typeof answer === "function" ? answer(calls.length) : answer;
    if (reply.throws) throw new Error(reply.throws);
    setImmediate(() => done(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? ""));
  };
  return { execFile, calls };
}

test("the probe says yes when a docker daemon answers with a server version", async () => {
  const { execFile, calls } = fakeExec({ stdout: "27.3.1\n" });
  const dockerAvailable = createDockerProbe({ execFile });
  assert.equal(await dockerAvailable(), true);
  assert.equal(calls.length, 1);
  // The SERVER version, not the client's: `docker` is installed on plenty of machines that cannot
  // reach a daemon, and "the binary exists" is not the question any caller here is asking.
  assert.deepEqual(calls[0].args, ["version", "--format", "{{.Server.Version}}"]);
  assert.equal(calls[0].file, "docker");
  // A probe with no timeout is a boot that hangs on a wedged daemon.
  assert.ok(Number(calls[0].options?.timeout) > 0, "the probe has to be able to give up");
});

test("the probe says no for the three ways docker is not here", async () => {
  // No binary at all: what a tenant relay on node:24-alpine has.
  const missing = createDockerProbe({ execFile: fakeExec({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) }).execFile });
  assert.equal(await missing(), false);

  // The binary is there and the socket is not: docker exits non-zero and prints nothing useful.
  const noSocket = createDockerProbe({ execFile: fakeExec({ error: new Error("Cannot connect to the Docker daemon"), stdout: "" }).execFile });
  assert.equal(await noSocket(), false);

  // Exit zero with an empty answer is not a yes either.
  const empty = createDockerProbe({ execFile: fakeExec({ stdout: "  \n" }).execFile });
  assert.equal(await empty(), false);
});

test("an execFile that throws where it stands is a no, not an unhandled rejection", async () => {
  const dockerAvailable = createDockerProbe({ execFile: fakeExec({ throws: "EACCES" }).execFile });
  assert.equal(await dockerAvailable(), false);
});

test("the probe runs once however many callers ask, and they all get the same answer", async () => {
  // Answering differently on a second call would show up as a disagreement if it were ever run
  // twice, which is exactly what this test is looking for.
  const { execFile, calls } = fakeExec((n) => (n === 1 ? { stdout: "27.3.1" } : { stdout: "" }));
  const dockerAvailable = createDockerProbe({ execFile });
  const answers = await Promise.all([dockerAvailable(), dockerAvailable(), dockerAvailable()]);
  assert.deepEqual(answers, [true, true, true]);
  assert.equal(await dockerAvailable(), true);
  assert.equal(calls.length, 1, `it shelled out ${calls.length} times`);
});

test("the refusal body is one shape, and every sentence is plain words", () => {
  assert.deepEqual(notAvailable("A sentence."), { error: "not_available", detail: "A sentence." });
  // The contract fixes this one word for word: it is what the console shows an owner who picks a
  // model on an instance that cannot switch.
  assert.equal(NOT_AVAILABLE.endpointsUse, "This instance cannot switch models from the console yet.");
  assert.equal(NOT_AVAILABLE.desktop, "The desktop view is not available on this instance yet.");
  for (const [name, sentence] of Object.entries(NOT_AVAILABLE)) {
    assert.ok(sentence.length > 0 && /[.]$/.test(sentence), `${name} is not a sentence: ${sentence}`);
    // Jason's rule for anything an owner reads. An em dash is the tell of copy written for us.
    assert.ok(!sentence.includes("—"), `${name} carries an em dash`);
    assert.ok(!/docker|socket|500|409|exec/i.test(sentence), `${name} says a word an owner should not have to know: ${sentence}`);
  }
});

// ---- the routes -------------------------------------------------------------------------------

// A copy of ui/, never ui/ itself: the operator's own auth.json and endpoints.json would change
// which branch runs, and a test that silently stops testing anything is worse than no test.
function serverCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-nodocker-"));
  for (const name of readdirSync(path.join(repoRoot, "ui")).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(path.join(repoRoot, "ui", name), path.join(dir, name));
  }
  return path.join(dir, "server.mjs");
}

// A PATH with nothing on it, or with a fake docker on it. execFile("docker", ...) resolves through
// PATH, so this is how a tenant's "no docker at all" is reproduced without touching the machine.
function pathDir({ docker = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-path-"));
  mkdirSync(dir, { recursive: true });
  if (docker != null) {
    const file = path.join(dir, "docker");
    writeFileSync(file, docker);
    chmodSync(file, 0o755);
  }
  return dir;
}

// No password, loopback: the relay's own no-auth branch, which is this Mac's workflow and leaves
// every route open so the test measures the docker refusal and not the login.
async function startRelay({ pathValue }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = serverCopy();
    const port = 34000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [entry], {
      env: {
        HOME: process.env.HOME, PATH: pathValue,
        SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
        // Nothing answers here. Every route under test is decided before the relay reaches
        // upstream, and a 502 from a dead port is itself proof a request got that far.
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
        SAND_HOST_GATEWAY_TOKEN: "not-a-real-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const listening = await new Promise((resolve) => {
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("auth none")) resolve(true); });
      child.on("exit", () => resolve(false));
      setTimeout(() => resolve(false), 15_000).unref();
    });
    if (listening) return { base: `http://127.0.0.1:${port}`, log: () => out, stop: () => child.kill("SIGKILL") };
    child.kill("SIGKILL");
  }
  throw new Error("the relay copy would not start on any of five ports");
}

test("a relay with no docker refuses the box-backed routes in words an owner can read", async () => {
  const relay = await startRelay({ pathValue: pathDir() });
  try {
    // The boot says it once, in the container log, so an operator reading it knows the console is
    // not broken.
    assert.match(relay.log(), /no docker on this relay/);

    const cases = [
      ["POST", "/endpoints/use", JSON.stringify({ id: "anything" }), NOT_AVAILABLE.endpointsUse],
      ["GET", "/box/surface?app=browser", null, NOT_AVAILABLE.desktop],
      ["POST", "/box/launch", JSON.stringify({ app: "browser" }), NOT_AVAILABLE.desktop],
      ["GET", "/connectors", null, NOT_AVAILABLE.connectors],
      ["POST", "/connectors", JSON.stringify({ mcpServers: {} }), NOT_AVAILABLE.connectors],
    ];
    for (const [method, route, body, detail] of cases) {
      const res = await fetch(`${relay.base}${route}`, {
        method, ...(body == null ? {} : { headers: { "content-type": "application/json" }, body }),
      });
      assert.equal(res.status, 409, `${method} ${route} answered ${res.status}`);
      assert.deepEqual(await res.json(), { error: "not_available", detail }, `${method} ${route}`);
    }
  } finally { relay.stop(); }
});

test("a relay with no docker still serves the pages and the reads that do not need it", async () => {
  const relay = await startRelay({ pathValue: pathDir() });
  try {
    // The catalog is a file on this side of the wall, so the list still answers. What it must not
    // do is present an unknown live row as a configured one.
    const endpoints = await fetch(`${relay.base}/endpoints`);
    assert.equal(endpoints.status, 200);
    const catalog = await endpoints.json();
    assert.ok(Array.isArray(catalog.endpoints));
    assert.equal(catalog.liveNote, NOT_AVAILABLE.liveModel);
    assert.equal(catalog.switchable, false);

    // /model is asked for on every console load, so a refusal there would be an error badge on a
    // page that is working. It answers, and says the answer is not knowable here.
    const model = await fetch(`${relay.base}/model`);
    assert.equal(model.status, 200);
    assert.deepEqual(await model.json(), { model: null, endpoint: null, source: "unknown", note: NOT_AVAILABLE.liveModel });

    // The login state is what the console asks for first. Nothing about it touches the box.
    const state = await fetch(`${relay.base}/auth/state`);
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { required: false, authenticated: true });

    // And the host bundle's version file is read off the mounted runtime directory, so the route
    // exists; with no directory configured it says so rather than reaching for docker.
    const runtime = await fetch(`${relay.base}/runtime/wrong-token/sand-host-bundle-latest.version`);
    assert.equal(runtime.status, 404, "a bad token is a 404, never a hint that the path is real");
  } finally { relay.stop(); }
});

test("the refusals are gated on the probe, not hardcoded: with docker answering, the routes run", async () => {
  // A docker that answers `version` and nothing else. The point is only that the probe says yes:
  // the routes then take their real path, which against this stub fails for its own reasons, and
  // "not the 409" is the whole assertion.
  const fake = "#!/bin/sh\ncase \"$1\" in version) echo 27.3.1 ;; *) exit 1 ;; esac\n";
  const relay = await startRelay({ pathValue: pathDir({ docker: fake }) });
  try {
    assert.ok(!/no docker on this relay/.test(relay.log()), "the probe said no on a machine where docker answers");
    const connectors = await fetch(`${relay.base}/connectors`);
    assert.notEqual(connectors.status, 409);
    const use = await fetch(`${relay.base}/endpoints/use`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nothing-by-this-name" }),
    });
    assert.notEqual(use.status, 409);
  } finally { relay.stop(); }
});
