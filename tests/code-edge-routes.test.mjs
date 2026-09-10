// The five box-facing routes, against an execFile that answers instead of a daemon (CODE-1).
//
// The case that matters most is not the happy path. It is what is left behind when the create path
// stops half way: a claim the control plane refused must leave no container, no network, no task
// directory and no row, because a task directory with a customer's instructions in it and no record
// anywhere is exactly the state nobody goes looking for.
//
// The order of the refusals is asserted as an ORDER, because the order is the security: a body is
// never read from a caller no workspace holds, and the local provider is refused before a directory
// is made on an instance that has no socket to run it with.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODE_REFUSALS, createCodeEdge, createE2bDriver, foldTasks, tarOneFile,
} from "../ui/code-edge.mjs";

const TOKEN = "gateway-token-for-demo";

function fakeRes() {
  return {
    status: 0, headers: {}, body: null, ended: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = { ...this.headers, ...headers }; return this; },
    end(payload) { this.ended = true; this.body = payload == null ? null : JSON.parse(String(payload)); return this; },
  };
}

const fakeReq = (body, { method = "POST", token = TOKEN } = {}) => ({
  method,
  headers: token == null ? {} : { authorization: `Bearer ${token}` },
  raw: typeof body === "string" ? body : JSON.stringify(body ?? {}),
});

/**
 * Everything injected, everything recorded. `docker` is a table of answers keyed on the first two
 * argv words, so a case that wants one call to fail says so and the rest of the path still runs.
 */
async function edgeWith(overrides = {}, { dockerAnswers = {}, boxFiles = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-routes-"));
  const seen = { docker: [], piped: [], opened: [], closed: [], rows: [], owned: [] };
  const rowsBySlug = new Map();

  const answer = (args) => {
    const key2 = `${args[0]} ${args[1]}`;
    const key1 = args[0];
    const found = dockerAnswers[key2] ?? dockerAnswers[key1];
    if (typeof found === "function") return found(args);
    if (found != null) return found;
    // The defaults: a machine with a proxy, one other network, and a create and start that work.
    if (key2 === "ps --filter") return { stdout: "titanbot-proxy-abc\n" };
    if (key2 === "network ls") return { stdout: "bridge\ntitanbot-net\n" };
    if (key2 === "network inspect") {
      if (args.includes("{{.Id}}")) return { stdout: args.at(-1) === "titanbot-net" ? "sharedid\n" : "mineid\n" };
      if (args.includes("{{.Name}}\t{{range .IPAM.Config}}{{.Subnet}},{{end}}")) {
        return { stdout: "bridge\t172.17.0.0/16,\ntitanbot-net\t192.168.48.0/20,\n" };
      }
      return { stdout: "" };
    }
    if (key1 === "exec" && args.includes("id")) return { stdout: "1000\n" };
    if (key1 === "exec") {
      const wanted = String(args.at(-1)).match(/'([^']+)'/)?.[1] ?? "";
      const content = boxFiles[wanted];
      return content == null ? { ok: false, stderr: "no such file" } : { stdout: content };
    }
    if (key1 === "inspect") return { stdout: "running\t0\tfalse\n" };
    if (key1 === "logs") return { stdout: "working\n" };
    return { stdout: "" };
  };

  const edge = createCodeEdge({
    execFile: (file, args, opts, cb) => {
      seen.docker.push(args);
      const given = answer(args);
      const ok = given.ok !== false;
      setImmediate(() => cb(ok ? null : Object.assign(new Error(given.stderr ?? "failed"), { code: 1 }),
        given.stdout ?? "", given.stderr ?? ""));
    },
    readBody: async (req, max) => {
      if (req.raw.length > max) { const error = new Error("too large"); error.code = "BODY_TOO_LARGE"; throw error; }
      return req.raw;
    },
    drainThenEnd: async (req, res, status, headers, payload) => { res.writeHead(status, headers); res.end(payload); },
    workspaceOf: (bearer) => (bearer === TOKEN ? { slug: "demo", name: "Demo Company" } : null),
    taskRootFor: (slug, taskId) => path.join(root, slug, "workspace", "code", taskId),
    credRootFor: (slug) => path.join(root, slug, "code-cred"),
    boxOf: () => "titanbot-box-demo",
    ownLikeParent: async (file) => { seen.owned.push(file); },
    readTasks: async (slug) => (rowsBySlug.get(slug) ?? []),
    writeTask: async (slug, row) => {
      seen.rows.push(row);
      const kept = (rowsBySlug.get(slug) ?? []).filter((r) => r.taskId !== row.taskId);
      rowsBySlug.set(slug, [row, ...kept]);
    },
    openTask: async (row) => {
      seen.opened.push(row);
      return { ok: true, id: 11, key: "sk-titanbot-task-0123456789", alias: "titanbot-demo-code-x", model: "plan-zai-code", capUsd: 2, minutesCap: 30 };
    },
    closeTask: async (row) => { seen.closed.push(row); },
    dockerAvailable: async () => true,
    pipeInto: async (file, args, input) => { seen.piped.push({ args, input }); return { code: 0, stdout: "", stderr: "" }; },
    settingsFor: () => ({ image: "titanbot/code-sandbox:1" }),
    log: () => {},
    ...overrides,
  });
  return { edge, seen, root, rowsBySlug };
}

const GOOD = { agentId: "a_titan", title: "primes", instructions: "write a python script that prints the first 20 primes and a test for it, then run the test" };

const start = async (body = GOOD, options = {}, setup = {}, overrides = {}) => {
  const made = await edgeWith(overrides, setup);
  const res = fakeRes();
  await made.edge.handleStart(fakeReq(body, options), res);
  return { ...made, res };
};

// ---- the happy path, and what it proves about custody -------------------------------------------

test("a task starts, and the key reached the container on stdin and nothing else", async () => {
  const { res, seen, root } = await start();
  assert.equal(res.status, 200);
  assert.equal(res.body.started, true);
  assert.match(res.body.taskId, /^[0-9a-f]{12}$/);
  assert.equal(res.body.provider, "local");
  assert.equal(res.body.capUsd, 2);
  assert.ok(res.body.deadlineAt > Date.now(), "a deadline in the past is a task the sweep kills at once");

  const key = "sk-titanbot-task-0123456789";
  // THE KEY IS IN EXACTLY ONE PLACE: the tar that went in on stdin between create and start.
  assert.equal(seen.piped.length, 1);
  assert.deepEqual(seen.piped[0].args.slice(0, 2), ["cp", "-"]);
  assert.ok(Buffer.from(seen.piped[0].input).toString("utf8").includes(key));
  // And in no argv at all: not the create, not a label, not an -e, not the network, not the start.
  for (const args of seen.docker) {
    assert.ok(!args.some((part) => String(part).includes(key)),
      `the key reached an argv: docker ${args.join(" ")}`);
  }
  // Nor anywhere on the host's disk. The task directory holds the instructions and nothing else.
  const written = await readdir(path.join(root, "demo", "workspace", "code", res.body.taskId));
  assert.deepEqual(written, ["task.json"]);
  const saved = JSON.parse(await readFile(path.join(root, "demo", "workspace", "code", res.body.taskId, "task.json"), "utf8"));
  assert.equal(saved.instructions, GOOD.instructions);
  assert.ok(!JSON.stringify(saved).includes(key));
});

test("the order of the docker calls is the order the design needs, and start is last", async () => {
  const { seen } = await start();
  const verbs = seen.docker.map((args) => `${args[0]} ${args[1] ?? ""}`.trim());
  const at = (needle) => verbs.findIndex((v) => v.startsWith(needle));
  assert.ok(at("network create") < at("network connect"), "the network exists before the proxy joins it");
  assert.ok(at("network connect") < at("create"), "the proxy is on the network before the task is created");
  assert.ok(at("create") < at("start"), "created, then given the credential, then started");
  assert.ok(verbs.at(-1).startsWith("start"), "nothing happens after start");
  // And the instructions never travelled on a command line, which is the same rule as the key.
  for (const args of seen.docker) {
    assert.ok(!args.some((part) => String(part).includes("first 20 primes")),
      "the instructions reached an argv");
  }
});

test("the claim is made before the container exists and carries no title and no instructions", async () => {
  const { seen } = await start();
  assert.equal(seen.opened.length, 1);
  assert.deepEqual(Object.keys(seen.opened[0]).sort(), ["agentId", "provider", "slug", "taskId"]);
  const payload = JSON.stringify(seen.opened[0]);
  assert.ok(!payload.includes("primes"), "the operator's ledger row holds no title");
  assert.ok(!payload.includes("python"), "and no instructions: the customer's own words stay on the relay");
});

test("the named files are copied in, numbered when two share a name, and owned like their directory", async () => {
  const { res, root, seen } = await start(
    { ...GOOD, files: ["/workspace/a/app.py", "/workspace/b/app.py"] },
    {},
    { boxFiles: { "/workspace/a/app.py": "print('a')\n", "/workspace/b/app.py": "print('b')\n" } },
  );
  assert.equal(res.status, 200);
  const dir = path.join(root, "demo", "workspace", "code", res.body.taskId);
  assert.deepEqual((await readdir(dir)).sort(), ["app-2.py", "app.py", "task.json"]);
  assert.equal(await readFile(path.join(dir, "app.py"), "utf8"), "print('a')\n");
});

test("the directory's owner and the container's --user are the same one number", async () => {
  // THE INVARIANT, and the bug it is here for. These two used to come from two places: the directory
  // was chowned like its PARENT and --user came from the box's own `id -u`. Measured on the R750
  // 2026-09-10 they disagreed -- directory 0:0, container 1000:1000 -- and the first thing the agent
  // inside did was fail with "cannot create /task/SUMMARY.md: Permission denied", which reaches a
  // person as a coding job that did nothing and said nothing. One value now owns both halves.
  for (const boxUid of ["0", "1000", "1001"]) {
    const { res, seen } = await start(GOOD, {}, { dockerAnswers: { exec: (args) => (args.includes("id") ? { stdout: `${boxUid}\n` } : { stdout: "" }) } });
    assert.equal(res.status, 200);
    const create = seen.docker.find((args) => args[0] === "create");
    const at = create.indexOf("--user");
    assert.ok(at > 0, "the container is always given a user");
    assert.equal(create[at + 1], `${boxUid}:${boxUid}`,
      `a box whose own id -u is ${boxUid} gets a task that runs as ${boxUid}; zero is an answer, not an absence`);
  }
});

// ---- the refusals, in order ---------------------------------------------------------------------

test("a caller no workspace holds is refused before its body is read", async () => {
  const made = await edgeWith();
  const res = fakeRes();
  // A body that would fail the size check, so a 401 proves the body was never read at all.
  await made.edge.handleStart({ method: "POST", headers: { authorization: "Bearer nobody" }, raw: "x".repeat(10 << 20) }, res);
  assert.equal(res.status, 401);
  assert.equal(made.seen.docker.length, 0, "nothing on the machine was touched");
  assert.equal(made.seen.opened.length, 0);
});

test("a relay with no docker answers the contract's own sentence and offers the other road", async () => {
  const { res, seen, root } = await start(GOOD, {}, {}, { dockerAvailable: async () => false });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "not_available");
  // The sentence is ui/docker-edge.mjs's NOT_AVAILABLE.codeTask word for word, plus the offer: a dead
  // control on a customer's instance is a support ticket, not a feature that is honestly absent.
  assert.ok(res.body.message.startsWith(CODE_REFUSALS.not_available));
  assert.match(res.body.message, /cloud coding computer/);
  // AND NOTHING WAS MADE. The refusal comes before the task directory, which is the whole reason the
  // provider check sits where it does.
  assert.equal(seen.opened.length, 0);
  await assert.rejects(() => stat(path.join(root, "demo")));
});

test("a body with no title, no instructions, no agent or a repo is refused by name", async () => {
  for (const [body, error] of [
    [{ ...GOOD, title: "" }, "no_title"],
    [{ ...GOOD, instructions: "   " }, "no_instructions"],
    [{ ...GOOD, agentId: "" }, "no_agent"],
    // Refused BY NAME rather than ignored. A task has no egress, so a clone cannot run; silence would
    // teach the model the clone happened, and a parameter that always refuses would teach it a
    // capability it does not have. CODE-2.
    [{ ...GOOD, repo: "https://github.com/x/y" }, "no_repo"],
  ]) {
    const { res, seen } = await start(body);
    assert.equal(res.status, 400, `${error} should be a 400`);
    assert.equal(res.body.error, error);
    assert.equal(seen.opened.length, 0, `${error} must not claim anything`);
  }
});

test("a file that climbs, a relative path or the host's own store refuses the whole task", async () => {
  for (const bad of ["/home/box/../../etc/shadow", "notes.md", "/home/box/sand-data/store.db", "/etc/passwd"]) {
    const { res, seen } = await start({ ...GOOD, files: [bad] });
    assert.equal(res.status, 400, `${bad} must be refused`);
    assert.equal(res.body.error, "bad_file");
    assert.equal(seen.docker.length, 0, "a refused path costs no docker call at all");
  }
});

test("a provider nobody implemented is refused rather than falling back to one", async () => {
  const { res } = await start({ ...GOOD, provider: "somebody-elses-cloud" });
  assert.equal(res.body.error, "provider_unknown");
});

test("two running tasks is the cap, and the third is told so in plain words", async () => {
  const made = await edgeWith();
  made.rowsBySlug.set("demo", [
    { taskId: "aaaaaaaaaaaa", state: "running", startedAt: Date.now() },
    { taskId: "bbbbbbbbbbbb", state: "running", startedAt: Date.now() },
  ]);
  const res = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), res);
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "concurrent");
  assert.equal(res.body.message, CODE_REFUSALS.concurrent);
  assert.equal(made.seen.opened.length, 0);
});

// ---- the half-started cases, which are the ones that matter -------------------------------------

test("a claim the control plane refused stops the create and leaves nothing behind", async () => {
  const { res, seen, root } = await start(GOOD, {}, {}, {
    openTask: async () => ({ ok: false, error: "unreachable", message: "no answer" }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "no_record");
  assert.equal(res.body.message, CODE_REFUSALS.no_record);
  // No container, no network, and no task directory with a customer's instructions in it.
  const verbs = seen.docker.map((args) => `${args[0]} ${args[1] ?? ""}`.trim());
  assert.ok(!verbs.some((v) => v.startsWith("network create")), "nothing was created after the claim failed");
  assert.ok(!verbs.some((v) => v === "create" || v.startsWith("start")));
  assert.equal(seen.piped.length, 0, "and the credential was never asked for");
  // The task directory went with it. A directory holding a customer's instructions and no record of it
  // anywhere is exactly the state nobody goes looking for.
  assert.deepEqual(await readdir(path.join(root, "demo", "workspace", "code")), [],
    "the task directory is removed again");
});

test("a missing image is a plain sentence, and the network and the claim are both closed", async () => {
  const { res, seen } = await start(GOOD, {}, {
    dockerAnswers: { create: { ok: false, stderr: "Unable to find image 'titanbot/code-sandbox:1' locally: no such image" } },
  });
  assert.equal(res.body.error, "no_image");
  assert.equal(res.body.message, CODE_REFUSALS.no_image);
  // The row is closed as failed, so no container-hour is left unbilled and no bot waits forever.
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].id, 11);
  assert.equal(seen.closed[0].outcome, "failed");
  // And the network went with it.
  const verbs = seen.docker.map((args) => args.join(" "));
  assert.ok(verbs.some((v) => v.startsWith("network rm") || v.startsWith("rm -f")), "the network is removed");
});

test("a proxy nothing carries the label for is a refusal, not a task with no model", async () => {
  const { res, seen } = await start(GOOD, {}, { dockerAnswers: { "ps --filter": { stdout: "\n" } } });
  assert.equal(res.body.error, "no_proxy");
  assert.equal(seen.closed[0].outcome, "failed");
  assert.equal(seen.piped.length, 0);
});

test("a task network that resolved to the shared network is refused and nothing is started", async () => {
  // The check that cannot be a name comparison: the whole point is that something above handed us a
  // network that is not ours, and only the id docker resolves settles it.
  const { res, seen } = await start(GOOD, {}, {
    dockerAnswers: {
      "network inspect": (args) => (args.includes("{{.Id}}") ? { stdout: "sharedid\n" } : { stdout: "" }),
    },
  });
  assert.equal(res.status, 503);
  const verbs = seen.docker.map((args) => `${args[0]} ${args[1] ?? ""}`.trim());
  assert.ok(!verbs.includes("create"), "no container was ever created on the shared network");
  assert.equal(seen.piped.length, 0);
});

test("a pool with no free subnet is a plain sentence rather than a collision", async () => {
  const full = Array.from({ length: 256 }, (_, n) => `full${n}\t10.97.${n}.0/24,`).join("\n");
  const { res } = await start(GOOD, {}, {
    dockerAnswers: {
      "network ls": { stdout: Array.from({ length: 256 }, (_, n) => `full${n}`).join("\n") },
      "network inspect": (args) => (args.includes("{{.Id}}") ? { stdout: "mineid\n" } : { stdout: full }),
    },
  });
  assert.equal(res.body.error, "no_pool");
  assert.equal(res.body.message, CODE_REFUSALS.no_pool);
});

test("a daemon that will not take a tar on stdin falls back to a file outside every box mount", async () => {
  const { res, seen, root } = await start(GOOD, {}, {}, {
    pipeInto: async () => ({ code: 1, stdout: "", stderr: "Error: unexpected EOF" }),
  });
  assert.equal(res.status, 200, "the fallback is a working task, not a refusal");
  const credFile = path.join(root, "demo", "code-cred", `${res.body.taskId}.env`);
  assert.equal((await readFile(credFile, "utf8")).includes("sk-titanbot-task-0123456789"), true);
  assert.equal((await stat(credFile)).mode & 0o777, 0o600);
  // OUTSIDE the workspace tree, so the box can never read it. That is the custody rule the fallback
  // still has to keep.
  assert.ok(!credFile.includes(path.join("demo", "workspace")));
  // Mounted read only, and the first container was removed rather than left beside the second.
  const create = seen.docker.find((args) => args[0] === "create" && args.join(" ").includes("code-cred"));
  assert.ok(create.join(" ").includes(":ro"));
  assert.ok(seen.docker.some((args) => args[0] === "rename"), "the fallback container takes the task's own name");
});

test("with no fallback directory a daemon that refuses stdin is a refusal and not a key on disk", async () => {
  const { res, seen } = await start(GOOD, {}, {}, {
    pipeInto: async () => ({ code: 1, stdout: "", stderr: "no" }),
    credRootFor: () => "",
  });
  assert.equal(res.status, 503);
  assert.equal(seen.closed[0].outcome, "failed");
});

// ---- status, stop, result, list -----------------------------------------------------------------

test("status answers running with the last lines, and the key's shape is never in them", async () => {
  const made = await edgeWith({}, { dockerAnswers: {
    inspect: { stdout: "running\t0\tfalse\n" },
    logs: { stdout: "calling the model with Authorization: Bearer sk-titanbot-task-0123456789\n3 passed\n" },
  } });
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const res = fakeRes();
  await made.edge.handleStatus(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.state, "running");
  assert.equal(res.body.provider, "local");
  assert.ok(res.body.elapsedS >= 0);
  assert.ok(!JSON.stringify(res.body.lines).includes("sk-titanbot-task"), "the log is redacted relay-side");
  assert.ok(res.body.lines.includes("3 passed"), "and still says something useful");
});

test("a container that exited settles the row once, closes the claim and removes itself", async () => {
  const made = await edgeWith({}, { dockerAnswers: { inspect: { stdout: "exited\t0\tfalse\n" } } });
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const res = fakeRes();
  await made.edge.handleStatus(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), res);
  assert.equal(res.body.state, "done");
  assert.equal(made.seen.closed.length, 1);
  assert.equal(made.seen.closed[0].outcome, "done");
  assert.ok(made.seen.closed[0].minutes >= 0);
  const verbs = made.seen.docker.map((args) => args.join(" "));
  assert.ok(verbs.some((v) => v.startsWith("rm -f tbcode-")), "the container is removed");
  assert.ok(verbs.some((v) => v.startsWith("network disconnect")), "the proxy is detached");
  assert.ok(verbs.some((v) => v.startsWith("network rm tbcode-")), "and the network goes");
  // Asked twice, settled once.
  const again = fakeRes();
  await made.edge.handleStatus(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), again);
  assert.equal(made.seen.closed.length, 1, "a finished task is not closed a second time");
});

test("a task killed for memory says so, and an exit code is not read as a verdict on its own", async () => {
  const made = await edgeWith({}, { dockerAnswers: { inspect: { stdout: "exited\t137\ttrue\n" } } });
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const res = fakeRes();
  await made.edge.handleStatus(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), res);
  assert.equal(res.body.state, "failed");
  assert.match(made.seen.closed[0].detail, /out of memory/);
});

test("result hands back the files where the bot can already read them, and the bot's own path", async () => {
  const made = await edgeWith({}, { dockerAnswers: { inspect: { stdout: "exited\t0\tfalse\n" } } });
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const taskId = started.body.taskId;
  const dir = path.join(made.root, "demo", "workspace", "code", taskId);
  await writeFile(path.join(dir, "primes.py"), "print(2)\n");
  await writeFile(path.join(dir, "SUMMARY.md"), "Wrote primes.py and its test. Both pass.\n");
  // The fallback credential file, if that leg had run, must never be listed as an artifact.
  await writeFile(path.join(dir, ".code-cred.env"), "ANTHROPIC_AUTH_TOKEN='sk-x'\n");

  const res = fakeRes();
  await made.edge.handleResult(fakeReq({ agentId: "a_titan", taskId }), res);
  assert.equal(res.body.ready, true);
  assert.match(res.body.summary, /Wrote primes.py/);
  // THE BOT'S OWN PATH, not the host's. A /data path in a model's context is one it tries, fails to
  // open, and then reports to a person as missing.
  assert.equal(res.body.path, `/workspace/code/${taskId}`);
  assert.ok(!JSON.stringify(res.body).includes("/data/titanbot"));
  const names = res.body.files.map((f) => f.path);
  assert.ok(names.includes("primes.py"));
  assert.ok(!names.some((n) => n.startsWith(".code-cred")), "a credential file is never an artifact");
  assert.ok(res.body.files.find((f) => f.path === "primes.py").bytes > 0);
  assert.match(res.body.message, /left \d+ files? in \/workspace\/code\//);
});

test("result on a running task says it is running rather than handing back half a tree", async () => {
  const made = await edgeWith();
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const res = fakeRes();
  await made.edge.handleResult(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), res);
  assert.equal(res.body.ready, false);
  assert.equal(res.body.message, CODE_REFUSALS.not_ready);
});

test("stop ends a running task and answers a sentence; stopping a finished one says so", async () => {
  const made = await edgeWith();
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const res = fakeRes();
  await made.edge.handleStop(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), res);
  assert.equal(res.body.stopped, true);
  assert.equal(made.seen.closed[0].outcome, "stopped");
  const again = fakeRes();
  await made.edge.handleStop(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), again);
  assert.equal(again.body.stopped, false);
  assert.equal(again.body.message, CODE_REFUSALS.not_running);
});

test("a task id from another shape, or one this workspace does not have, is one sentence either way", async () => {
  const made = await edgeWith();
  for (const taskId of ["../../etc", "a b", "ffffffffffff"]) {
    const res = fakeRes();
    await made.edge.handleStatus(fakeReq({ agentId: "a_titan", taskId }), res);
    assert.equal(res.body.found, false);
    assert.equal(res.body.message, CODE_REFUSALS.unknown_task);
  }
  assert.equal(made.seen.docker.length, 0, "a task id that is not one costs no docker call");
});

test("list is this workspace's own tasks and carries no instructions", async () => {
  const made = await edgeWith();
  await made.edge.handleStart(fakeReq(GOOD), fakeRes());
  const res = fakeRes();
  await made.edge.handleList(fakeReq({ agentId: "a_titan" }), res);
  assert.equal(res.body.tasks.length, 1);
  assert.equal(res.body.tasks[0].title, "primes");
  assert.ok(!JSON.stringify(res.body).includes("python"), "a list goes into a model's context on every poll");
});

// ---- the console's own read ---------------------------------------------------------------------

test("the console reads the same rows and says where it ran in plain words", async () => {
  const made = await edgeWith();
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  const shown = await made.edge.handleConsoleTasks("demo");
  assert.equal(shown.tasks.length, 1);
  assert.equal(shown.tasks[0].where, "this computer", "no vendor name and no container word on a person's screen");
  assert.equal(shown.tasks[0].path, `/workspace/code/${started.body.taskId}`);
  const settings = made.edge.handleConsoleSettings("demo");
  assert.equal(settings.internet, false);
  assert.equal(settings.where, "this computer");
  // And a Stop from the console does the same thing a Stop from the bot does.
  const stopped = await made.edge.handleConsoleStop("demo", started.body.taskId);
  assert.equal(stopped.stopped, true);
  assert.equal(made.seen.closed[0].outcome, "stopped");
});

// ---- the E2B driver, against a stub -------------------------------------------------------------

test("the cloud driver narrows egress, sends the instructions as a file, and never logs the key", async () => {
  const calls = [];
  const lines = [];
  const driver = createE2bDriver({
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init.body == null ? null : JSON.parse(String(init.body)) });
      return { status: 200, json: async () => ({ sandboxID: "sbx_123" }) };
    },
    env: { CODE_E2B_API_BASE: "http://stub.invalid" },
    log: (line) => lines.push(line),
  });
  const made = await driver.start({
    key: "e2b_secret_key_value", template: "ksvvz1yj8id2n6aozgfw",
    taskId: "aaaaaaaaaaaa", slug: "demo", minutes: 30, instructions: "write the primes script",
  });
  assert.equal(made.ok, true);
  assert.equal(made.sandboxId, "sbx_123");
  assert.equal(calls[0].body.allowInternetAccess, false, "a cloud task is no more connected than a local one");
  assert.equal(calls[0].body.templateID, "ksvvz1yj8id2n6aozgfw");
  assert.equal(calls[0].body.timeout, 1800, "the wall clock is set on the sandbox, so it dies on its own");
  assert.equal(calls[0].init.headers["X-API-KEY"], "e2b_secret_key_value");
  // The instructions go in as a FILE, the same rule as locally.
  assert.match(calls[1].url, /\/files$/);
  assert.match(calls[1].body.path, /task\.json$/);
  // And nothing logged the key.
  assert.ok(!lines.join("\n").includes("e2b_secret_key_value"));
});

test("a cloud task is honest about what cannot be metered rather than reporting a zero", async () => {
  const driver = createE2bDriver({
    fetchImpl: async () => ({ status: 200, json: async () => ({ entries: [{ name: "primes.py", size: 42 }] }) }),
    env: { CODE_E2B_API_BASE: "http://stub.invalid" },
  });
  const got = await driver.collect({ key: "e2b_k", sandboxId: "sbx_123" });
  assert.deepEqual(got.files, [{ path: "primes.py", bytes: 42 }]);
  // NOT zero. An E2B microVM cannot reach the proxy this product meters through, so the spend is not
  // attributed, and a zero on a panel is a claim that nothing was spent. CODE-3.
  assert.equal(got.spend, null);
  assert.match(got.spendReason, /not attributed/);
});

test("a cloud task with no key refuses before it starts anything", async () => {
  const driver = createE2bDriver({ fetchImpl: async () => { throw new Error("nothing should be called"); } });
  assert.equal((await driver.start({ key: "", template: "t" })).error, "no_e2b_key");
  assert.equal((await driver.start({ key: "k", template: "" })).error, "no_e2b_key");
});

test("a cloud task selected by the workspace starts on the cloud and never touches docker", async () => {
  const { res, seen } = await start({ ...GOOD, provider: "e2b" }, {}, {}, {
    settingsFor: () => ({ e2bTemplate: "ksvvz1yj8id2n6aozgfw" }),
    openTask: async () => ({ ok: true, id: 12, key: "", alias: "", model: "", capUsd: 2, minutesCap: 30, e2bKey: "e2b_k" }),
    e2b: {
      provider: "e2b",
      start: async () => ({ ok: true, sandboxId: "sbx_999" }),
      status: async () => ({ ok: true, state: "running", lines: [] }),
      stop: async () => ({ ok: true }),
      collect: async () => ({ ok: true, files: [], spend: null, spendReason: "x" }),
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, "e2b");
  const verbs = seen.docker.map((args) => `${args[0]} ${args[1] ?? ""}`.trim());
  assert.ok(!verbs.some((v) => v.startsWith("network create") || v === "create"),
    "a cloud task makes nothing on this machine");
});

// ---- the tar the create path actually writes ----------------------------------------------------

test("the tar the route pipes in is one the entrypoint can source", async () => {
  const { seen } = await start();
  const tar = Buffer.from(seen.piped[0].input);
  // Byte for byte what tarOneFile produces for the same key, so the route is not building its own.
  const body = tar.subarray(512, 1024).toString("utf8").replace(/\0+$/, "");
  assert.equal(body, "ANTHROPIC_AUTH_TOKEN='sk-titanbot-task-0123456789'\n");
  assert.equal(tar.length, tarOneFile("env", body).length);
});

test("the rows this workspace keeps fold to one per task and carry the customer's own words", async () => {
  const made = await edgeWith({}, { dockerAnswers: { inspect: { stdout: "exited\t0\tfalse\n" } } });
  const started = fakeRes();
  await made.edge.handleStart(fakeReq(GOOD), started);
  await made.edge.handleStatus(fakeReq({ agentId: "a_titan", taskId: started.body.taskId }), fakeRes());
  const folded = foldTasks(made.seen.rows.map((row) => JSON.stringify(row)).join("\n"));
  assert.equal(folded.length, 1, "one row per task however many times its state moved");
  assert.equal(folded[0].state, "done");
  assert.equal(folded[0].title, "primes", "the title is the workspace's own, and stays on the relay");
});

// ---- the seam between this relay and the control plane ------------------------------------------

test("the control plane close is given longer than the proxy takes to book a spend, and asked twice", async () => {
  // MEASURED ON THE R750 2026-09-10. `codeTaskClose` lives in ui/server.mjs module scope and is not
  // exported, so this reads it as text -- which is the right shape anyway, because what must not
  // regress is a NUMBER somebody could reasonably tidy back down. The control plane reads the task's
  // model spend off the per-task key before it answers, and the proxy books a key's spend with the
  // same batch writer /spend/logs is filled from: about fifteen seconds, so that read waits twenty.
  // With a 10 s deadline here the relay logged "could not close task row 2: The operation was
  // aborted due to timeout" for a close that was working, which leaves a container's minutes
  // unbilled -- the one thing the claim-before-the-container rule exists to prevent.
  const text = await readFile(new URL("../ui/server.mjs", import.meta.url), "utf8");
  const decl = text.indexOf("async function codeTaskClose");
  assert.ok(decl > 0, "codeTaskClose is still the name of the close");
  // From its own doc comment, because the reason the retry is safe is written there and a reason is
  // the half of this that a future reader needs more than the number.
  const at = text.lastIndexOf("/**", decl);
  // Bounded to this function alone: the next declaration after it carries its own, shorter deadline,
  // and a window that runs past the closing brace reads that one and fails for the wrong reason.
  const rest = text.slice(at + 1);
  const ends = rest.indexOf("\n/**");
  const body = rest.slice(0, ends > 0 ? ends : 2400);
  assert.match(body, /AbortSignal\.timeout\(/, "the close still carries a deadline");
  const attempts = body.match(/for \(const deadline of \[([^\]]+)\]\)/);
  assert.ok(attempts != null, "the deadlines are a list, which is what makes the retry readable");
  const deadlines = attempts[1].split(",").map((n) => Number(n.trim().replace(/_/g, "")));
  assert.equal(deadlines.length, 2, "asked twice: once, and once more if the first timed out");
  for (const ms of deadlines) {
    assert.ok(ms >= 25_000, `a close deadline of ${ms} ms is shorter than the spend read it is waiting on`);
  }
  assert.match(body, /TimeoutError/, "a timeout is the failure it asks again about");
  assert.match(body, /already/, "and the retry is safe because the other side answers already:true");
});
