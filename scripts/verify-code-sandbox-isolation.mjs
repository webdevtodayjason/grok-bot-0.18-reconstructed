#!/usr/bin/env node
// verify-code-sandbox-isolation.mjs -- what a coding sandbox can and cannot reach (CODE-1, docs/CODE.md).
//
// This is the gate that decides whether the local provider may ship at all. Everything else in the
// wave is a plan that can be read; the boundary is a kernel behaviour that can only be measured, from
// inside a real container, against a real daemon.
//
// HOW IT MEASURES, AND WHY NOT THE OBVIOUS WAY. Every reachability leg asserts an APPLICATION-LEVEL
// answer or a KERNEL ERROR and never a bare TCP connect:
//
//   * "the proxy answers" means an HTTP 200 with the body we put there, not a socket that opened. A
//     socket to a container that is up but not serving opens and proves nothing.
//   * "the internet is shut" means Errno 101 (network unreachable) or a name that does not resolve,
//     both of which are the kernel and the resolver saying so. A TIMEOUT is NOT accepted as proof:
//     measured on this Mac, a timeout is what a firewall in front of a reachable network also looks
//     like, and a leg that accepts it passes on a machine with a slow route.
//   * "the host is shut" means ConnectionRefused is NOT enough either. --internal leaves the bridge
//     gateway on-link, so the host's own ports answer ConnectionRefused rather than unreachable, which
//     is exactly why deploy/r750/box-isolation.sh carries the static pool drop. On this Mac there is no
//     nftables, so this leg records what it sees and names the R750 leg as the one that proves the rule.
//
// THE PROXY IS A CONTAINER, NOT THIS PROCESS. host.docker.internal does not resolve from inside an
// --internal network (measured), so a stub listening on the Mac is unreachable by construction and a
// gate written that way would "prove" the boundary by failing to reach its own stub. The stub is a
// container attached to the task network with the alias the real proxy is given.
//
// WHAT IT STANDS UP AND WHAT IT MUST NOT TOUCH. Its own containers and networks are named
// tbcode-gate-*, removed at the end and on the way in. The codeprobe-* containers belong to a reader
// and are never listed, filtered on, or removed.
//
//   node scripts/verify-code-sandbox-isolation.mjs                 every leg
//   node scripts/verify-code-sandbox-isolation.mjs --no-build      reuse the image that is there
//   node scripts/verify-code-sandbox-isolation.mjs --only isolation
//
// 600 s ceiling. Every docker call carries a timeout, so a daemon that stops answering fails a leg
// rather than hanging the gate.
import { execFile as execFileCb, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CODE_CRED_DIR, CODE_POOL_PREFIX, PROXY_ALIAS, allocateSubnet, createArgs, credentialEnv,
  networkCreateArgs, parseNetworkSubnets, tarOneFile,
} from "../ui/code-edge.mjs";

const execFile = promisify(execFileCb);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every container and network this gate makes. One prefix, so the cleanup can be exact and a reader's
// codeprobe-* containers are never in the blast radius.
const RUN = randomBytes(4).toString("hex");
const GATE = `tbcode-gate-${RUN}`;
const GATE_PREFIX = "tbcode-gate-";
const GATE_UA = "titanbot-gate/verify-code-sandbox-isolation";
const IMAGE = process.env.TITANBOT_CODE_IMAGE ?? "titanbot/code-sandbox:1";
// The machine every number below belongs to. A measurement with no machine on it is not one.
const MACHINE = `${hostname()} (${process.platform}/${process.arch})`;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = "") => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] != null ? args[at + 1] : fallback;
};
const ONLY = valueOf("--only", "");
const wants = (leg) => ONLY.length === 0 || ONLY === leg;

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const note = (label, detail = "") => console.log(`  note  ${label}${detail ? ` -- ${detail}` : ""}`);
const step = (title) => console.log(`\n== ${title}`);

const docker = async (argv, { timeoutMs = 60_000, input = null } = {}) => {
  if (input != null) {
    return await new Promise((resolve) => {
      const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
      child.stdout.on("data", (c) => { stdout += String(c); });
      child.stderr.on("data", (c) => { stderr += String(c); });
      child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error?.message ?? error) }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: Number(code ?? -1), stdout, stderr }); });
      child.stdin.end(input);
    });
  }
  try {
    const { stdout, stderr } = await execFile("docker", argv, { timeout: timeoutMs, maxBuffer: 16 << 20 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    return { code: Number(error?.code ?? 1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
  }
};

/** Our own leftovers from a previous run, and NOTHING else. Never a label filter on the product's own
 *  role, because a real task may be running on this machine while the gate runs. */
async function sweepOurOwn(why) {
  const ps = await docker(["ps", "-a", "--format", "{{.Names}}"]);
  const mine = ps.stdout.split("\n").map((l) => l.trim()).filter((n) => n.startsWith(GATE_PREFIX));
  for (const name of mine) await docker(["rm", "-f", name]);
  const nets = await docker(["network", "ls", "--format", "{{.Name}}"]);
  const myNets = nets.stdout.split("\n").map((l) => l.trim()).filter((n) => n.startsWith(GATE_PREFIX));
  for (const name of myNets) {
    const members = await docker(["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", name]);
    for (const member of members.stdout.trim().split(" ").filter((m) => m.length > 0)) {
      await docker(["network", "disconnect", "-f", name, member]);
    }
    await docker(["network", "rm", name]);
  }
  if (mine.length + myNets.length > 0) note(`${why}: removed ${mine.length} gate container(s) and ${myNets.length} gate network(s)`);
  return { containers: mine.length, networks: myNets.length };
}

/** One script inside a container, ON STDIN, with its exit code and both streams.
 *
 *  NOT through `sh -c`: nested quoting through docker exec is a measured trap in this repo and every
 *  probe below is several lines of shell. And NOT through `docker cp` into /tmp either, which is the
 *  first thing that was tried and is worth the comment: MEASURED on this Mac, `docker cp` into a path
 *  covered by `--tmpfs /tmp` writes into the image layer UNDERNEATH the tmpfs, so the running process
 *  sees nothing and every probe returned an empty string while exiting 2. A gate written that way reads
 *  "the task cannot reach anything", which is a pass for the wrong reason. Stdin has no such corner. */
async function inside(container, script, { timeoutMs = 40_000 } = {}) {
  return await docker(["exec", "-i", container, "/bin/sh"], { timeoutMs, input: script });
}

/** Whether a container exists, by EXACT name. `docker ps --filter name=x` is a substring match, so
 *  filtering on the sandbox's name also matches `<name>-proxy` and a removal check passes or fails for
 *  the wrong reason. Measured here the hard way. */
async function exists(name) {
  const ps = await docker(["ps", "-a", "--format", "{{.Names}}"]);
  return ps.stdout.split("\n").map((l) => l.trim()).includes(name);
}

const t0 = Date.now();
const budget = () => Math.round((Date.now() - t0) / 1000);

console.log(`verify-code-sandbox-isolation  ${GATE_UA}`);
console.log(`machine  ${MACHINE}`);

// ---- 0. the daemon, and our own leftovers -------------------------------------------------------

step("the daemon");
const version = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
if (version.code !== 0 || version.stdout.trim().length === 0) {
  check(false, "a docker daemon answers on this machine", "nothing below can be measured without one");
  console.log("\n1 FAILED");
  process.exit(1);
}
const DAEMON = version.stdout.trim();
check(true, `docker ${DAEMON} on ${MACHINE}`);
const cgroup = await docker(["info", "--format", "{{.CgroupVersion}} {{.CgroupDriver}}"], { timeoutMs: 15_000 });
note(`cgroup ${cgroup.stdout.trim() || "unknown"}`, "the task's cpu, memory and pids limits are cgroup behaviour");
await sweepOurOwn("on the way in");

// ---- 1. the image -------------------------------------------------------------------------------

if (wants("image") || ONLY.length === 0) {
  step("the image");
  if (has("--no-build")) {
    const there = await docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"], { timeoutMs: 20_000 });
    check(there.code === 0, `${IMAGE} is already on this machine`, "--no-build was given");
  } else {
    const started = Date.now();
    const built = await docker(["buildx", "build", "--load", "-t", IMAGE, path.join(repo, "deploy/r750/code-sandbox")], { timeoutMs: 420_000 });
    const seconds = Math.round((Date.now() - started) / 1000);
    check(built.code === 0, `the image builds from deploy/r750/code-sandbox`, built.code === 0 ? `${seconds} s on ${MACHINE}` : built.stderr.slice(-300));
  }
  // Size, and the base it came from, both named with the machine.
  const size = await docker(["image", "inspect", IMAGE, "--format", "{{.Size}}"], { timeoutMs: 20_000 });
  const bytes = Number(size.stdout.trim() || 0);
  note(`size ${Math.round(bytes / 1000 / 1000)} MB content on ${MACHINE}`);
  const dockerfile = await readFile(path.join(repo, "deploy/r750/code-sandbox/Dockerfile"), "utf8");
  note(`base ${dockerfile.match(/^FROM (\S+)/m)?.[1] ?? "unreadable"}`, "pinned by digest");
  // And that it carries no credential at all: this is the thing a customer's task runs inside.
  const env = await docker(["image", "inspect", IMAGE, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { timeoutMs: 20_000 });
  check(!/sk-|_KEY=|_TOKEN=|_SECRET=/.test(env.stdout), "the image's own environment holds no credential");
  const probe = await docker(["run", "--rm", "--entrypoint", "/bin/sh", IMAGE, "-c",
    "claude --version; python3 -V; rg --version | head -1"], { timeoutMs: 90_000 });
  check(probe.code === 0 && /Claude Code/.test(probe.stdout), "the agent and the tools are in the image",
    probe.stdout.trim().split("\n").join("; "));
}

// ---- 2. the network, the proxy stub, and one real task ------------------------------------------

const NETWORK = GATE;
const SANDBOX = GATE;
const PROXY = `${GATE}-proxy`;
const NEIGHBOUR = `${GATE}-neighbour`;
const NEIGHBOUR_NET = `${GATE}-other`;
const KEY = `sk-gate-${randomBytes(12).toString("hex")}`;
const MARK = `code-gate-${RUN}`;
let taskRoot = "";
let delivery = "none";

if (wants("isolation") || wants("task") || ONLY.length === 0) {
  step("the task network and the proxy");

  // The subnet comes from the real allocator against the real daemon, so the pool arithmetic is
  // measured and not assumed.
  const names = (await docker(["network", "ls", "--format", "{{.Name}}"])).stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const inspected = await docker(["network", "inspect", "--format", "{{.Name}}\t{{range .IPAM.Config}}{{.Subnet}},{{end}}", ...names]);
  const subnet = allocateSubnet(parseNetworkSubnets(inspected.stdout).map((r) => r.subnet));
  check(subnet.startsWith(CODE_POOL_PREFIX), "the allocator picked a subnet inside the pool", `${subnet} on ${MACHINE}`);

  const netStart = Date.now();
  const made = await docker(networkCreateArgs({ taskId: `gate-${RUN}`, subnet, slug: "gate" }));
  check(made.code === 0, "an --internal network is created", `${Date.now() - netStart} ms on ${MACHINE}`);

  // THE PROXY IS A CONTAINER ON THAT NETWORK. host.docker.internal does not resolve from inside an
  // --internal network, so a stub on the host is unreachable by construction.
  const proxyScript = [
    "import http.server, socketserver",
    "class H(http.server.BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    "        self.send_response(200); self.send_header('content-type','text/plain'); self.end_headers()",
    f_(),
    "    def do_POST(self): self.do_GET()",
    "    def log_message(self, *a): pass",
    "socketserver.TCPServer.allow_reuse_address = True",
    "socketserver.TCPServer(('0.0.0.0', 4000), H).serve_forever()",
  ].join("\n");
  const dir = await mkdtemp(path.join(os.tmpdir(), "code-gate-proxy-"));
  await writeFile(path.join(dir, "proxy.py"), proxyScript);
  // THE ROLE LABEL, because the relay finds the proxy by label and never by name. Without it the
  // sweep's disconnect finds no proxy, `network rm` fails with "has active endpoints", and the leg below
  // reports a network that would not go. Found by running this gate.
  const proxyUp = await docker(["run", "-d", "--name", PROXY, "--network", NETWORK,
    "--network-alias", PROXY_ALIAS, "--label", "com.titanbot.role=proxy",
    "-v", `${dir}:/stub:ro`, "--entrypoint", "python3",
    IMAGE, "/stub/proxy.py"]);
  check(proxyUp.code === 0, `a stub proxy answers on the task network as ${PROXY_ALIAS}`, proxyUp.code === 0 ? "" : proxyUp.stderr.slice(-200));

  // A neighbour on a DIFFERENT bridge, which is the thing one-network-per-task exists to stop. On a
  // shared internal network a task reached a peer by container name (measured); this proves the
  // per-task network closes that.
  await docker(["network", "create", NEIGHBOUR_NET]);
  await docker(["run", "-d", "--name", NEIGHBOUR, "--network", NEIGHBOUR_NET, "--entrypoint", "python3",
    IMAGE, "-c", "import http.server,socketserver;socketserver.TCPServer(('0.0.0.0',4000),http.server.SimpleHTTPRequestHandler).serve_forever()"]);
  const neighbourAddr = (await docker(["inspect", "--format",
    `{{(index .NetworkSettings.Networks "${NEIGHBOUR_NET}").IPAddress}}`, NEIGHBOUR])).stdout.trim();
  note(`a neighbour container sits on another bridge at ${neighbourAddr}`);

  step("one real task");
  taskRoot = await mkdtemp(path.join(os.tmpdir(), "code-gate-task-"));
  // The task the product's own gate asks for, so this is not a synthetic workload.
  await writeFile(path.join(taskRoot, "task.json"), JSON.stringify({
    taskId: `gate-${RUN}`,
    title: "primes",
    instructions: "Write a python script that prints the first 20 primes, and a test for it. Run the test.",
  }, null, 2));

  // The REAL plan, out of the module the relay uses, so the argv under measurement is the argv that
  // ships. The entrypoint is replaced with a shell that keeps the container up: a real agent turn needs
  // a model, and what this leg measures is the boundary, not the agent.
  const plan = createArgs({
    taskId: `gate-${RUN}`, slug: "gate", agentId: "gate", taskRoot,
    uid: 1000, gid: 1000, deadlineAt: Date.now() + 600_000, image: IMAGE,
    model: "gate-stub", cpus: 2, memory: "2g", pids: 512,
  });
  // --name is ours, and the entrypoint is a sleep so the probes below have something to run inside.
  const argv = plan.map((part) => (part === `tbcode-gate-${RUN}` ? SANDBOX : part));
  const withEntry = [...argv.slice(0, argv.length - 1), "--entrypoint", "/bin/sh", argv.at(-1), "-c", "sleep 600"];
  const created = await docker(withEntry);
  check(created.code === 0, "the real create plan is accepted by the daemon", created.code === 0 ? "" : created.stderr.slice(-300));

  // THE CREDENTIAL, the way the relay delivers it: a tar on stdin between create and start.
  const piped = await docker(["cp", "-", `${SANDBOX}:${CODE_CRED_DIR}`],
    { input: tarOneFile("env", credentialEnv(KEY), { mode: 0o600, uid: 1000, gid: 1000 }) });
  if (piped.code === 0) { delivery = "stdin-tar"; check(true, "the credential went in as a tar on stdin", `measured on ${MACHINE}`); }
  else {
    delivery = "cred-file";
    check(false, "the credential went in as a tar on stdin", `${piped.stderr.slice(-200)}; the fallback bind is the leg that ships`);
  }
  const started = await docker(["start", SANDBOX]);
  check(started.code === 0, "the task starts", started.code === 0 ? "" : started.stderr.slice(-200));

  // ---- the custody legs, which are reads of what the daemon will tell anybody -------------------
  step("custody");
  const inspect = await docker(["inspect", SANDBOX]);
  check(!inspect.stdout.includes(KEY), "the credential is absent from docker inspect",
    "this is the whole of MARKET-17 in one assertion");
  const envOnly = await docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", SANDBOX]);
  check(!envOnly.stdout.includes(KEY), "and from Config.Env, which docker prints to any reader");
  const labels = await docker(["inspect", "--format", "{{range $k,$v := .Config.Labels}}{{$k}}={{$v}} {{end}}", SANDBOX]);
  check(!labels.stdout.includes(KEY), "and from every label");
  check(/com\.titanbot\.deadline=\d{13}/.test(labels.stdout), "the deadline is on the container as epoch ms",
    "the only wall clock that survives a relay restart");
  // And the mount is one mount.
  const mounts = await docker(["inspect", "--format", "{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}", SANDBOX]);
  const mountList = mounts.stdout.trim().split(" ").filter((m) => m.length > 0);
  check(mountList.length === 1, "the task has exactly one mount", mountList.join(" "));
  check(!mounts.stdout.includes("docker.sock"), "and it is not the docker socket");
  // The credential the task itself can see, once. The entrypoint sources and truncates it; this
  // container is running a sleep instead, so the file is still there and that is what proves it arrived.
  const sees = await inside(SANDBOX, `cat ${CODE_CRED_DIR}/env 2>/dev/null | head -c 40\n`);
  check(sees.stdout.includes("ANTHROPIC_AUTH_TOKEN"), "the task can read its own credential and nothing else can");

  // ---- THE ISOLATION LEGS ------------------------------------------------------------------------
  step("what the task can reach, measured from inside it");

  // 1. THE PROXY ANSWERS, at the application level. A socket that opens proves nothing.
  const toProxy = await inside(SANDBOX, [
    "#!/bin/sh",
    `code=$(curl -s -o /tmp/body -w '%{http_code}' --max-time 8 http://${PROXY_ALIAS}:4000/v1/models)`,
    'printf "status=%s body=%s\\n" "$code" "$(head -c 60 /tmp/body)"',
  ].join("\n"));
  check(/status=200/.test(toProxy.stdout) && toProxy.stdout.includes(MARK),
    "the proxy answers 200 with its own body", `${toProxy.stdout.trim()} on ${MACHINE}`);

  // 2. THE INTERNET IS SHUT, by kernel error and never by timeout. 101 is ENETUNREACH: the kernel has
  //    no route at all. A timeout would also be what a firewall in front of a reachable network looks
  //    like, so it is recorded and NOT accepted.
  const outward = await inside(SANDBOX, [
    "#!/bin/sh",
    "for target in 1.1.1.1:443 104.18.2.35:443; do",
    '  out=$(curl -s -S --max-time 8 "http://$target" 2>&1 || true)',
    '  printf "%s => %s\\n" "$target" "$(printf "%s" "$out" | head -c 120)"',
    "done",
    "python3 - <<'PY'",
    "import socket, errno",
    "for host, port in ((\"1.1.1.1\", 443), (\"8.8.8.8\", 53)):",
    "    try:",
    "        s = socket.create_connection((host, port), 6); s.close(); print(f'{host}:{port} OPEN')",
    "    except OSError as e:",
    "        print(f'{host}:{port} errno={e.errno} {errno.errorcode.get(e.errno, \"?\")}')",
    "PY",
  ].join("\n"), { timeoutMs: 60_000 });
  const byIp = outward.stdout;
  const unreachable = /errno=101/.test(byIp) || /Network (is )?unreachable/i.test(byIp);
  check(unreachable && !/OPEN/.test(byIp), "a public address gives ENETUNREACH from inside the task",
    `${byIp.trim().split("\n").join(" | ")} on ${MACHINE}`);
  if (/timed out|Timeout/i.test(byIp) && !unreachable) {
    note("a timeout is NOT accepted as proof", "a firewall in front of a reachable network looks the same");
  }

  // 3. AND NO NAME RESOLVES, which is the other half: a task that could resolve could be pointed
  //    somewhere by a DNS answer even with no default route.
  const resolving = await inside(SANDBOX, [
    "#!/bin/sh",
    "python3 - <<'PY'",
    "import socket",
    "for name in ('api.anthropic.com', 'registry.npmjs.org', 'example.com'):",
    "    try:",
    "        print(name, socket.getaddrinfo(name, 443)[0][4][0])",
    "    except Exception as e:",
    "        print(name, 'UNRESOLVED', type(e).__name__)",
    "PY",
  ].join("\n"), { timeoutMs: 60_000 });
  const resolvedCount = (resolving.stdout.match(/UNRESOLVED/g) ?? []).length;
  check(resolvedCount === 3, "api.anthropic.com, registry.npmjs.org and example.com do not resolve",
    `${resolving.stdout.trim().split("\n").join(" | ")} on ${MACHINE}`);

  // 4. THE PROXY'S OWN NEIGHBOURS ARE SHUT. The real proxy has a postgres beside it on its own
  //    network, and a task on the task network must not reach it even though the proxy is on both.
  const proxyAddr = (await docker(["inspect", "--format",
    `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, PROXY])).stdout.trim();
  const sideways = await inside(SANDBOX, [
    "#!/bin/sh",
    "python3 - <<PY",
    "import socket, errno",
    `for host, port in (("${proxyAddr}", 5432), ("${neighbourAddr}", 4000)):`,
    "    try:",
    "        s = socket.create_connection((host, port), 5); s.close(); print(f'{host}:{port} OPEN')",
    "    except OSError as e:",
    "        print(f'{host}:{port} errno={e.errno} {errno.errorcode.get(e.errno, \"?\")}')",
    "PY",
  ].join("\n"), { timeoutMs: 60_000 });
  check(!/OPEN/.test(sideways.stdout), "5432 on the proxy and a neighbour on another bridge are both shut",
    `${sideways.stdout.trim().split("\n").join(" | ")} on ${MACHINE}`);

  // 5. THE HOST. This is the leg the R750 run exists for. --internal leaves the bridge gateway ON-LINK,
  //    so these ports answer ConnectionRefused rather than unreachable on a machine with no nftables
  //    rule in front of them. On this Mac that is the expected reading and it is recorded as a note;
  //    the R750 leg, with box-isolation.sh's static pool drop installed, is where it must read shut.
  const gateway = (await docker(["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", NETWORK])).stdout.trim();
  const hostward = await inside(SANDBOX, [
    "#!/bin/sh",
    "python3 - <<PY",
    "import socket, errno",
    `for port in (22, 445, 2049, 5000, 8000, 11434, 5432):`,
    "    try:",
    `        s = socket.create_connection(("${gateway}", port), 4); s.close(); print(f'{port} OPEN')`,
    "    except OSError as e:",
    "        print(f'{port} errno={e.errno} {errno.errorcode.get(e.errno, \"?\")}')",
    "PY",
  ].join("\n"), { timeoutMs: 60_000 });
  const anyOpen = /OPEN/.test(hostward.stdout);
  const allUnreachable = !anyOpen && !/errno=111/.test(hostward.stdout);
  if (allUnreachable) {
    check(true, `every host port on the bridge gateway ${gateway} is unreachable from inside the task`,
      `${hostward.stdout.trim().split("\n").join(" | ")} on ${MACHINE}`);
  } else {
    check(!anyOpen, `no host port on ${gateway} answered from inside the task`,
      `${hostward.stdout.trim().split("\n").join(" | ")} on ${MACHINE}`);
    note("ConnectionRefused, not unreachable, is the expected reading here",
      "--internal leaves the gateway on-link; deploy/r750/box-isolation.sh's 10.97.0.0/16 drop is what closes it, and the R750 run is the leg that proves that");
  }

  // 6. The limits really are limits, read off the container rather than off the plan.
  const limits = await docker(["inspect", "--format",
    "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}", SANDBOX]);
  const [nano, mem, swap, pids] = limits.stdout.trim().split(" ");
  check(Number(nano) === 2_000_000_000, "2 cpus", `NanoCpus=${nano}`);
  check(Number(mem) === 2 * 1024 ** 3 && Number(swap) === Number(mem), "2 GB with swap equal to it", `${mem}/${swap}`);
  check(Number(pids) === 512, "512 processes", `PidsLimit=${pids}`);
  check(/ALL/.test(limits.stdout) && /no-new-privileges/.test(limits.stdout), "every capability dropped and no new privileges");
  const who = await inside(SANDBOX, "#!/bin/sh\nid -u\n");
  check(who.stdout.trim() === "1000", "and it runs as the box's own user, so its artifacts are readable",
    `uid ${who.stdout.trim()}`);
}

// ---- 3. the crash case: the relay dies mid-task --------------------------------------------------

if (wants("sweep") || ONLY.length === 0) {
  step("a relay that died mid-task");
  // The relay's own sweep, constructed here exactly as ui/server.mjs constructs it, with an EMPTY live
  // map: that is precisely the state a restarted relay is in, and it is the state in which the obvious
  // implementation kills nothing and leaves a bot waiting forever on a row nobody closes.
  const { createCodeEdge } = await import("../ui/code-edge.mjs");
  const closed = [];
  const edge = createCodeEdge({
    execFile: execFileCb,
    readBody: async () => "{}",
    drainThenEnd: async () => {},
    workspaceOf: () => null,
    taskRootFor: () => taskRoot,
    credRootFor: () => "",
    readTasks: async () => [{ taskId: `gate-${RUN}`, state: "running", startedAt: Date.now() - 90_000, claimId: 99, provider: "local" }],
    writeTask: async () => {},
    openTask: async () => ({ ok: false }),
    closeTask: async (row) => { closed.push(row); },
    dockerAvailable: async () => true,
    log: (line) => note(line),
  });
  // It is our own gate container the sweep will find, which is only safe because it carries the product's
  // labels: that is the point of the leg. A real task running on this machine while the gate runs would
  // also be found, which is why this leg is local-only and the R750 run does not include it.
  const before = await exists(SANDBOX);
  const swept = await edge.sweep("the gate, pretending to be a relay that just started");
  check(before && swept.containers >= 1, "the next start's sweep found the orphan and removed it",
    `${swept.containers} container(s), ${swept.networks} network(s) on ${MACHINE}`);
  check(closed.length >= 1 && closed[0].outcome === "failed", "and closed its row, so no container hour is unbilled",
    closed.length === 0 ? "nothing was closed" : `outcome=${closed[0].outcome} minutes=${closed[0].minutes}`);
  check(!await exists(SANDBOX), "the container is gone");
  const net = await docker(["network", "ls", "--format", "{{.Name}}"]);
  check(!net.stdout.split("\n").map((l) => l.trim()).includes(NETWORK), "the task network is gone");
  check(await exists(PROXY), "and the proxy is still running, detached rather than removed",
    "the real proxy is shared by every tenant and must outlive every task");
}

// ---- 4. and the artifacts are where the bot reads them ------------------------------------------

if (taskRoot.length > 0) {
  step("the artifacts");
  const left = await readdir(taskRoot).catch(() => []);
  check(left.includes("task.json"), "the task directory survives the container it was mounted into",
    `${left.join(", ")} -- and it is the directory the bot already mounts as /workspace/code/<task>, so there is no copy-back`);
  check(!(await Promise.all(left.map((f) => readFile(path.join(taskRoot, f), "utf8").catch(() => ""))))
    .some((text) => text.includes(KEY)), "and no credential was left in it");
}

// ---- clean up, always ---------------------------------------------------------------------------

step("clean up");
const removed = await sweepOurOwn("on the way out");
await docker(["network", "rm", NEIGHBOUR_NET]);
if (taskRoot.length > 0) await rm(taskRoot, { recursive: true, force: true });
const left = await docker(["ps", "-a", "--format", "{{.Names}}"]);
const mine = left.stdout.split("\n").map((l) => l.trim()).filter((n) => n.startsWith(GATE_PREFIX));
check(mine.length === 0, "every container this gate made is gone", `removed ${removed.containers} on the way out`);
// And the reader's own probes are untouched, which is the one thing this gate must not do.
const readers = left.stdout.split("\n").map((l) => l.trim()).filter((n) => n.startsWith("codeprobe-"));
note(`${readers.length} codeprobe-* container(s) on this machine, untouched`, "they belong to a reader");

console.log(`\ncredential delivery: ${delivery} on ${MACHINE}`);
console.log(`${failures === 0 ? "OK" : `${failures} FAILED`}  (${budget()} s of a 600 s ceiling on ${MACHINE})`);
process.exit(failures === 0 ? 0 : 1);

// The stub's one line of body, kept down here because it is the only thing in this file that is a
// literal the assertions above match on.
function f_() {
  return `        self.wfile.write(b'${MARK}')`;
}
