#!/usr/bin/env node
// verify-deploy.mjs -- the R750 deploy gate, run FROM THE MAC over the tailnet.
//
// It proves six things in order, because a failure in an earlier one explains every later one:
//   1. shape      both titanbot containers run, their published ports are where they should be
//                 (the relay on 100.110.83.82 only, the box on 127.0.0.1 only, nothing on 0.0.0.0),
//                 the box's four data mounts are the titanbot volumes' own directories, and the
//                 host bundle running inside the box is the one on the server
//   2. gateway    getHostStatus and listAgents answer 200 through http://100.110.83.82:7787
//   3. login      no credential is turned away, a wrong password is refused, and a request
//                 carrying the gateway bearer is given a session that reaches the gateway on its
//                 own
//   4. writes     a probe agent is created and deleted, and the roster returns to its baseline
//   5. console    the Machine Room loads in real headless Chrome, on the bearer alone, and the
//                 roster paints
//   6. desktop    a probe agent's screen opens through the relay's own /vnc route, the frame is
//                 noVNC, and its websocket reaches the box
//   7. job bus    /v1/health is 401 without a bearer and never 200, the bearer given as
//                 --job-token opens /v1 and nothing else, and it is 200 with that bearer
//                 (docs/JOB-BUS.md §9, amended by §10.6 and §10.8)
//   8. lockout    six wrong passwords in a row hit the rate limit
//
// With --url it runs against any base URL instead of the tailnet one, which is what the Coolify
// deployment needs: https://tb.semfreak.dev goes through Cloudflare and Traefik, so the published
// ports it would otherwise assert do not exist and the containers are not necessarily called what
// this file calls them (they are found by their com.titanbot.role label instead). Four checks come
// with it: the certificate is valid for the name asked for, HSTS is on a TLS response, a forged
// forwarded header does NOT buy a guesser a fresh lockout bucket, and -- the one that matters --
// neither does going around Cloudflare to the origin, which is the path a guesser would actually
// take.
//
//   node scripts/verify-deploy.mjs --url https://tb.semfreak.dev
//   node scripts/verify-deploy.mjs --url https://tb.semfreak.dev --origin 66.90.191.45
//   node scripts/verify-deploy.mjs --url https://tb.semfreak.dev --job-token "$TITAN_JOB_TOKEN"
//
// This gate does not know the console password and no longer asks for one. Jason's password is
// his; a file holding a copy of it beside the token was a second secret to keep in step, and it
// drifted. What the gate proves instead is the shape of the door: the wrong password is refused,
// the lockout holds, and the way IN is the bearer, which this gate reads over ssh anyway and
// which is already full access. Holding it and being let in is not a privilege the gate invented.
//
// The server's bearer token is read over ssh at test time and held in memory only. It is never
// written to disk on this Mac and never printed.
//
//   node scripts/verify-deploy.mjs
//
// Env: TITANBOT_HOST (ssh destination, default dell-remote), TITANBOT_URL (default
// http://100.110.83.82:7787), TITANBOT_ROOT, TITANBOT_ORIGIN (the address behind the proxy, default
// 66.90.191.45), GROK_BOT_PLAYWRIGHT_DIR, GROK_BOT_CHROME, TITAN_JOB_TOKEN (the fallback for
// --job-token).
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import https from "node:https";
import tls from "node:tls";

// --url <base> or --url=<base>. Everything else about the run is unchanged, including reading the
// server's bearer over ssh: the gate still needs the token, and the token still lives on the
// server rather than on this Mac.
const urlFlag = (() => {
  const inline = process.argv.find((arg) => arg.startsWith("--url="));
  if (inline != null) return inline.slice("--url=".length);
  const at = process.argv.indexOf("--url");
  return at === -1 ? null : process.argv[at + 1];
})();

// --job-token <value>: the Titan Job Bus bearer, so the gate can prove the bus opens for the
// right key as well as staying shut without one (docs/JOB-BUS.md §9). Without it the closed-door
// half still runs and the open half is reported inconclusive, because a gate that quietly skips a
// check is a gate that stops being read. Never printed, never written down.
const JOB_TOKEN = (() => {
  const inline = process.argv.find((arg) => arg.startsWith("--job-token="));
  if (inline != null) return inline.slice("--job-token=".length);
  const at = process.argv.indexOf("--job-token");
  return at === -1 ? (process.env.TITAN_JOB_TOKEN?.trim() || null) : process.argv[at + 1];
})();

// The address the proxied name actually lands on, used only by the origin-bypass check below.
const originFlag = (() => {
  const inline = process.argv.find((arg) => arg.startsWith("--origin="));
  if (inline != null) return inline.slice("--origin=".length);
  const at = process.argv.indexOf("--origin");
  return at === -1 ? null : process.argv[at + 1];
})();

const HOST = process.env.TITANBOT_HOST ?? "dell-remote";
const ORIGIN_IP = originFlag ?? process.env.TITANBOT_ORIGIN ?? "66.90.191.45";
const ROOT = process.env.TITANBOT_ROOT ?? "/home/sem/titanbot";
const BIND = process.env.TITANBOT_BIND ?? "100.110.83.82";
const PORT = process.env.TITANBOT_PORT ?? "7787";
const URL_BASE = (urlFlag ?? process.env.TITANBOT_URL ?? `http://${BIND}:${PORT}`).replace(/\/+$/, "");
// A base this gate was pointed at rather than the tailnet publish it knows the shape of.
const EXTERNAL = urlFlag != null;
const OVER_TLS = URL_BASE.startsWith("https://");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
let inconclusive = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
// Not every leg of this gate can reach a verdict from this Mac. A check that could not run is a
// third outcome and it is printed as one: calling it a PASS is how a gate starts lying, and
// calling it a FAIL is how a gate starts being ignored. It is counted, and the summary line says
// so, so a run that proved less than usual cannot look like a run that proved everything.
const unresolved = (label, detail) => {
  console.log(`  ????  ${label} -- INCONCLUSIVE: ${detail}`);
  inconclusive += 1;
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
const tombstones = async () => {
  const raw = await ssh(
    `docker exec ${BOX_NAME} cat /home/box/sand-data/agents/deleted-agents.json 2>/dev/null || echo '[]'`,
  ).catch(() => "[]");
  try { const value = JSON.parse(raw.trim() || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
};

step(`shape of the install on ${HOST}`);
// By label AND service, by name last. A compose orchestrator names a service's container after its
// own resource id, so the label is the only identifier that survives the move into Coolify -- but
// the label alone stopped being an identifier the day a second customer arrived.
//
// Measured on the R750 2026-09-07, with the demo tenant running: `docker ps --filter
// label=com.titanbot.role=relay | head -1` answered titanbot-relay-sy74dau8ilh1g4u7a9eaw8f8, which
// is DEMO's relay. Every leg below that reads a container -- both running, the port bindings, the
// mounts, the traefik pin, the box's own files -- was measuring a customer's containers and
// reporting the answer as though it were the console's. A green gate on the wrong machine is worse
// than a red one.
//
// TITANBOT_SERVICE is the Coolify service uuid whose containers this run is about. Coolify names
// them <compose service>-<uuid>, so the suffix is the part that tells one customer from another.
// Empty it, and this falls back to the label alone, which is right on a single-box install where
// there is one of everything and the names carry no uuid at all.
const SERVICE = process.env.TITANBOT_SERVICE ?? "p927bfqm83ioloibamlvyd7g";
const byRole = async (role, fallback) => {
  const names = (await ssh(`docker ps --filter label=com.titanbot.role=${role} --format '{{.Names}}'`)
    .catch(() => "")).trim().split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const mine = SERVICE.length > 0 ? names.filter((name) => name.endsWith(`-${SERVICE}`)) : names;
  if (mine.length > 0) return mine[0];
  // Nothing carries this service's uuid. One candidate is a single-box install whose containers are
  // named without one, and taking it is right. Several is a host with customers on it and no way to
  // tell which is the console, so this returns the plain name instead: the next check says that
  // container is not running, which is a red gate naming a container, and not a green one measuring
  // somebody else's.
  return names.length === 1 ? names[0] : fallback;
};
const BOX_NAME = process.env.TITANBOT_BOX ?? await byRole("box", "titanbot-box");
const RELAY_NAME = process.env.TITANBOT_RELAY ?? await byRole("relay", "titanbot-relay");
const running = JSON.parse(await ssh(
  `docker inspect ${BOX_NAME} ${RELAY_NAME} --format '{{json .State.Running}}' 2>/dev/null | paste -sd, - | sed 's/^/[/;s/$/]/'`,
).catch(() => "[]"));
check(running.length === 2 && running.every((r) => r === true), `${BOX_NAME} and ${RELAY_NAME} are both running`,
  running.length === 2 ? `${running}` : "one or both containers are missing");

// Port bindings, read as docker's own JSON rather than parsed out of `docker ps` text.
const ports = JSON.parse(await ssh(
  `docker inspect ${RELAY_NAME} ${BOX_NAME} --format '{{json .NetworkSettings.Ports}}' | paste -sd, - | sed 's/^/[/;s/$/]/'`,
).catch(() => "[{},{}]"));
const [relayPorts, boxPorts] = ports;
const bindingsOf = (map) => Object.entries(map ?? {}).flatMap(([container, list]) =>
  (list ?? []).map((b) => ({ container, host: `${b.HostIp}:${b.HostPort}` })));
const relayBindings = bindingsOf(relayPorts);
const boxBindings = bindingsOf(boxPorts);
if (EXTERNAL) {
  // Where the publish is concerned there is nothing to assert POSITIVELY against an arbitrary
  // base: inside Coolify the right answer is no published port at all, because only the proxy
  // reaches the relay. What still has to hold is that nothing is on a public interface, which is
  // the check below this one. docs/JOB-BUS.md §10.8 asks this gate to SAY that rather than let a
  // reader assume the bindings were checked, so the line stands whichever way the gate was run.
  check(true, "published ports are not asserted against a base URL this gate was handed (they are, run on the server)",
    `relay ${relayBindings.map((b) => `${b.container}->${b.host}`).join(" ") || "nothing published"}; box ${boxBindings.map((b) => b.host).join(" ") || "nothing published"}`);
} else {
  check(relayBindings.length === 1 && relayBindings[0].container === "7777/tcp" && relayBindings[0].host === `${BIND}:${PORT}`,
    `the relay publishes exactly 7777 on ${BIND}:${PORT}`, relayBindings.map((b) => `${b.container}->${b.host}`).join(" ") || "nothing published");
  check(boxBindings.length > 0 && boxBindings.every((b) => b.host.startsWith("127.0.0.1:")),
    "every box port is bound on the server's loopback only", boxBindings.map((b) => b.host).join(" ") || "nothing published");
}
const wideOpen = [...relayBindings, ...boxBindings].filter((b) => b.host.startsWith("0.0.0.0:") || b.host.startsWith(":::"));
check(wideOpen.length === 0, "no titanbot port is published on 0.0.0.0", wideOpen.map((b) => b.host).join(" ") || "none");

// ---- which address Traefik routes to (TENANT-5) -----------------------------------------------
// TENANT-5 put the relay on a second network, titanbot-net, because one console now serves every
// customer and it has to reach every customer's box. A container on more than one network is the
// arrangement Coolify's own documentation warns about, and here is why, measured on this server
// 2026-09-07: coolify-proxy is traefik:v3.6 started with --providers.docker=true and NO
// --providers.docker.network. With no default network Traefik takes the first entry of the
// container's network map, Go randomises map iteration order, and the choice is therefore
// redecided on every provider refresh. The symptom is console.titanium.bot answering 502 at random
// hours after a deploy that looked fine, which is the worst failure shape there is: it is not
// reproducible and it is not attributable to the deploy that caused it.
//
// The traefik.docker.network label pins it. This leg reads the label back OFF THE RUNNING
// CONTAINER after every restart rather than trusting the compose, because Coolify does not deploy
// the compose it was given: it parses it, rewrites parts of it and deploys the result. Custom
// labels are believed to survive that rewrite (com.titanbot.role does), but that is one sample of
// one label, and a stripped pin must be caught by a gate rather than by Jason's console going down
// on a Tuesday.
//
// One network and no label is the state BEFORE the migration and it is correct: there is nothing
// to pin. Two networks and no label is the trap.
{
  const networksOf = async (name) => Object.keys(JSON.parse(
    await ssh(`docker inspect ${name} --format '{{json .NetworkSettings.Networks}}'`).catch(() => "{}"),
  ) ?? {});
  const relayNetworks = await networksOf(RELAY_NAME);
  const pin = (await ssh(`docker inspect ${RELAY_NAME} --format '{{index .Config.Labels "traefik.docker.network"}}'`)
    .catch(() => "")).trim();
  const pinned = pin.length > 0 && pin !== "<no value>";
  if (relayNetworks.length <= 1) {
    check(true, "the relay is on one network, so Traefik has one address to choose from",
      relayNetworks.join(", ") || "none");
  } else {
    check(pinned, "the relay names which of its networks Traefik routes to",
      pinned ? `traefik.docker.network=${pin}` :
        `on ${relayNetworks.length} networks (${relayNetworks.join(", ")}) with no traefik.docker.network label: `
        + "Traefik picks one at random on every provider refresh and the console will 502 at random. "
        + "deploy/coolify/docker-compose.yml carries traefik.docker.network as a LITERAL network name, "
        + "because Coolify escapes a variable inside a labels block. Paste it again and redeploy, or take "
        + "the relay back off the second network.");
    check(!pinned || relayNetworks.includes(pin), "and it is a network this container is actually on",
      pinned ? `${pin} ${relayNetworks.includes(pin) ? "is" : "is NOT"} among ${relayNetworks.join(", ")}` : "there is no pin to check");
  }
}

// ---- one customer's box cannot reach another customer's box (TENANT-5) ------------------------
// The shared network is what makes one relay able to serve everybody, and containers on one bridge
// talk to each other freely. Measured on the R750 2026-09-07, before this leg existed: from inside
// the demo tenant's box, a scan of the operator's box answered OPEN on 1340, 6080 and 6081, and
// 6080's websockify offered VNC security type 1, None -- one customer holding another customer's
// screen and keyboard with no credential at all. Symmetric in both directions.
//
// deploy/r750/box-isolation.sh installs the rule (from a box, on that bridge, the relay's bundle
// port and nothing else) and its --verify runs the scan itself, from every box against every other
// box. This leg is that scan, so the gate measures the boundary rather than the rule.
let isolationOutput = "";
{
  const LABEL = "no customer's box can reach another customer's box on the shared network";
  const out = await ssh(`bash ${ROOT}/deploy/box-isolation.sh --verify 2>&1 || true`).catch((error) => String(error?.message ?? error));
  // TENANT-3. The same run now also probes box to HOST, and this leg reads that half of it. Until
  // 2026-09-08 --verify scanned box to box only, so this gate stood green while every host port was
  // open to every tenant -- a leg that reads as a proof and is not one.
  isolationOutput = String(out);
  const lines = String(out).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const open = lines.filter((line) => line.startsWith("OPEN ") || line.startsWith("BROKEN "));
  if (/there is no pair to scan/.test(out)) {
    check(true, LABEL, "one box on this network, so there is no second customer to reach");
  } else if (/^PASS\b/m.test(out)) {
    check(true, LABEL, lines.filter((line) => line.startsWith("closed ") || line.startsWith("ok ")).join("; ").slice(0, 300));
  } else if (/No such file|not found/.test(out)) {
    unresolved(LABEL, `${ROOT}/deploy/box-isolation.sh is not on the server; run deploy/r750/sync.sh, which ships it`);
  } else {
    check(false, LABEL, open.length > 0 ? open.join("; ") : String(out).slice(0, 300));
  }
}

// TENANT-3, its own leg, because it fails for its own reason and an operator reading a red gate
// should not have to work out which half of one line broke.
{
  const LABEL = "no customer's box can reach the host on the ports the guard drops";
  const out = isolationOutput;
  const openHost = out.split("\n").map((l) => l.trim()).filter((l) => /^OPEN\s+\S+ -> host /.test(l));
  const closedHost = out.split("\n").map((l) => l.trim()).filter((l) => /^closed\s+\S+ -> host /.test(l));
  // The space before `watch-only` was the second defect in this leg: box-isolation.sh writes the
  // marker in parentheses -- `... 5000 80 443 (watch-only; add to the drop set ...)` -- so a pattern
  // demanding a space in front of it matched nothing, on every host, always.
  const watched = out.split("\n").map((l) => l.trim()).filter((l) => /^note\s+\S+ -> host .*watch-only/.test(l));
  if (out.length === 0 || /No such file|not found/.test(out)) {
    unresolved(LABEL, `${ROOT}/deploy/box-isolation.sh is not on the server; run deploy/r750/sync.sh, which ships it`);
  } else if (/no box on this network, so there is nothing to probe the host from/.test(out)) {
    check(true, LABEL, "no box on this network, so there was nothing to probe the host from");
  } else if (openHost.length > 0) {
    check(false, LABEL, openHost.join("; ").slice(0, 400));
  } else if (closedHost.length + watched.length === 0) {
    unresolved(LABEL, "the isolation script ran but produced no box-to-host result, so this was not measured");
  } else {
    // A `note` line is a probed address too, and on this fleet it is the ONLY shape a healthy probe
    // takes. box-isolation.sh prints `closed ... -> host` only when NOTHING answered on any guarded
    // port, drop set and watch-only alike; if anything watch-only answers it prints `note` instead.
    // On the R750 80 and 443 are Coolify's own proxy and always answer, so this leg could never see
    // a `closed` line and read INCONCLUSIVE on every correct run -- a gate that cannot pass tells an
    // operator nothing, which is the same failure as a gate that cannot fail. Measured 2026-09-09:
    // six probed addresses across three boxes, every one a `note`, zero `closed`, zero OPEN.
    // What this leg asserts is the drop set, and the evidence for it is the absence of an OPEN line
    // on an address that was really probed.
    const probed = closedHost.length + watched.length;
    const note = watched.length > 0 ? ` (${watched.length} still answering on watch-only ports, which is what watch-only means)` : "";
    check(true, LABEL, `${probed} box-to-host probe(s), none open on the drop set${note}`);
  }
}

// ---- TENANT-4: which boxes actually carry the start-window repair -----------------------------
//
// The repair is real in the repo and shipped to the host, and it was measured on grok-bot-local-vm.
// That measurement said nothing about the R750, and on the R750 it was not in effect: read
// read-only 2026-09-08, /usr/local/bin/start-window was stock (md5 d69219af..., 0 hits for
// session_alive) on BOTH the demo box and Richard's, because the mechanism runs from the box
// entrypoint and every running box was started before that entrypoint existed. Only the operator's
// box carried it, from the old docker-socket run.
//
// So the gate names the boxes rather than the code. `session_alive` is the marker the patch writes
// and is what the patch itself tests for before doing anything, so it is the same predicate on both
// sides. An operator reading a red leg is told which box is running the stock file, which is the
// thing they can act on.
{
  const LABEL = "every box is running the repaired start-window, not the stock one";
  const names = (await ssh(`docker ps --filter label=com.titanbot.role=box --format '{{.Names}}'`).catch(() => "")).split("\n").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) {
    unresolved(LABEL, "docker named no running box on this host, so this was not measured");
  } else {
    const rows = [];
    for (const box of names) {
      const out = (await ssh(`docker exec ${box} sh -c 'md5sum /usr/local/bin/start-window 2>/dev/null | cut -c1-32; grep -c session_alive /usr/local/bin/start-window 2>/dev/null || echo 0' 2>/dev/null || true`).catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
      rows.push({ box, md5: out[0] ?? "?", hits: Number(out[1] ?? 0) });
    }
    const stock = rows.filter((r) => !(r.hits > 0));
    const detail = rows.map((r) => `${r.box} md5 ${r.md5.slice(0, 8)} ${r.hits > 0 ? "repaired" : "STOCK"}`).join("; ");
    check(stock.length === 0, LABEL, stock.length === 0
      ? detail
      : `${stock.length} of ${rows.length} box(es) run the stock start-window, so a forked agent there meets a black screen: ${detail}`);
  }
}

// ---- the four data mounts, which is the one thing that fails silently ------------------------
// Every agent, transcript and workspace on this box lives in four docker volumes. The hand install
// mounts them by name; the Coolify stack cannot, because Coolify's compose parser renames a named
// volume to "{service-uuid}_{slug}" and creates it empty, so that stack mounts the same volumes by
// the directory the local driver keeps them in. Both are correct only if the container's mount
// source is the volume's own mountpoint, and when it is not, everything below this line still
// passes: the console loads, the gateway answers, and there is simply nobody on the roster.
//
// So the gate asks docker for both halves and compares them. This replaces an operator squinting
// at `docker inspect` after a deploy, which is a check nobody performs twice.
const DATA_MOUNTS = {
  "/workspace": "titanbot-box-workspace",
  "/home/box/sand-data": "titanbot-box-data",
  "/var/lib/sand-box-store": "titanbot-box-store",
  "/home/box/chrome-profile": "titanbot-box-chrome",
};
const boxMounts = JSON.parse(await ssh(`docker inspect ${BOX_NAME} --format '{{json .Mounts}}'`).catch(() => "[]"));
const mountpoints = Object.fromEntries(
  (await ssh(`docker volume inspect ${Object.values(DATA_MOUNTS).join(" ")} --format '{{.Name}} {{.Mountpoint}}' 2>/dev/null || true`)
    .catch(() => "")).trim().split("\n").filter((line) => line.trim().length > 0)
    .map((line) => line.trim().split(/\s+/)));
const misdirected = Object.entries(DATA_MOUNTS).filter(([destination, volume]) => {
  const source = boxMounts.find((m) => m.Destination === destination)?.Source ?? "";
  return source.length === 0 || source !== mountpoints[volume];
});
check(misdirected.length === 0,
  "the box's four data mounts are the titanbot volumes' own directories",
  misdirected.length === 0
    ? Object.values(DATA_MOUNTS).map((v) => `${v} -> ${mountpoints[v]}`).join(", ")
    : misdirected.map(([destination, volume]) =>
      `${destination} comes from "${boxMounts.find((m) => m.Destination === destination)?.Source ?? "nothing"}" `
      + `and ${volume} lives at "${mountpoints[volume] ?? "no such volume"}"`).join("; ")
      + " -- this box has none of Jason's agents on it");

// And the host bundle, for the same reason and with the same failure mode. install.sh bind-mounts
// the file; the Coolify stack copies it in from a mounted directory at the box's start, because a
// single-file bind is what makes Coolify copy the file into its own database. Either way the only
// thing that matters is that the bytes running in the box are the bytes on the server, and a box
// quietly running the image's stock bundle looks entirely healthy from outside.
const bundleOnServer = (await ssh(`sha256sum ${ROOT}/runtime/host-main.cjs | cut -c1-64`).catch(() => "")).trim();
const bundleInBox = (await ssh(`docker exec ${BOX_NAME} sha256sum /home/box/sand-host/host-main.cjs | cut -c1-64`)
  .catch(() => "")).trim();
check(bundleOnServer.length === 64 && bundleInBox === bundleOnServer,
  "the box is running the host bundle that is on the server",
  bundleInBox === bundleOnServer ? `sha256 ${bundleInBox.slice(0, 16)}...`
    : `the box has ${bundleInBox.slice(0, 16) || "nothing"}... and the server has ${bundleOnServer.slice(0, 16) || "nothing"}...`);

// The token file is the single source of truth for the gateway bearer. Read it here, hold it in
// memory, and never let it reach this Mac's disk or this script's output.
const TOKEN = JSON.parse(await ssh(`cat ${ROOT}/profile/local-docker-vm.json`)).token ?? "";
check(TOKEN.length === 64 && /^[0-9a-f]+$/.test(TOKEN), "the server's gateway token is 64 hex characters", "value withheld");
const mode = (await ssh(`stat -c %a ${ROOT}/profile/local-docker-vm.json`)).trim();
check(mode === "600", "the token file is 0600 on the server", `mode ${mode}`);

// A password this gate invented, and therefore certainly wrong. Nothing here needs the real one:
// every check below is either about a credential being refused or about the bearer being accepted.
const WRONG = `not-the-console-password-${Math.random().toString(36).slice(2, 10)}`;

if (OVER_TLS) {
  step(`the certificate on ${new URL(URL_BASE).hostname}`);
  // rejectUnauthorized with a servername is the whole check: node verifies the chain AND matches
  // the name against the certificate's SAN, wildcards included, and refuses the socket otherwise.
  // Reading the fields afterwards is for the message, not for the verdict.
  const host = new URL(URL_BASE).hostname;
  const port = Number(new URL(URL_BASE).port || 443);
  const peer = await new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
      const certificate = socket.getPeerCertificate();
      const authorized = socket.authorized;
      socket.end();
      resolve({ authorized, certificate });
    });
    socket.setTimeout(20_000, () => { socket.destroy(); resolve({ authorized: false, error: "timed out" }); });
    socket.on("error", (error) => resolve({ authorized: false, error: error.message }));
  });
  const certificate = peer.certificate ?? {};
  const expires = Date.parse(certificate.valid_to ?? "");
  check(peer.authorized === true,
    `the certificate is valid and issued for ${host}`,
    peer.authorized === true
      ? `issuer ${certificate.issuer?.O ?? certificate.issuer?.CN ?? "?"}, subject ${certificate.subject?.CN ?? "?"}, names ${certificate.subjectaltname ?? "none"}`
      : peer.error ?? "the handshake was refused");
  check(Number.isFinite(expires) && expires > Date.now(),
    "and it has not expired", certificate.valid_to ?? "no notAfter");
}

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

const home = await hit("/", { headers: { accept: "text/html" } });
check(home.status === 302 && String(home.headers.get("location") ?? "").startsWith("/login"),
  "an unauthenticated browser asking for / is redirected to /login", `HTTP ${home.status} -> ${home.headers.get("location")}`);

const loginPage = await hit("/login", { headers: { accept: "text/html" } });
const loginHtml = loginPage.status === 200 ? await loginPage.text() : "";
check(loginPage.status === 200 && loginHtml.includes('type="password"') && loginHtml.includes('action="/login"'),
  "the login page renders one password field and posts to /login", `HTTP ${loginPage.status}, ${loginHtml.length} bytes`);

if (OVER_TLS) {
  // A response that arrived over TLS carries HSTS, so a browser that has seen this console once
  // will not try plain HTTP to the name again. It is on the refusals as well as the pages, which
  // is why the login page is what this reads it off.
  const hsts = loginPage.headers.get("strict-transport-security");
  check(/max-age=\d+/.test(String(hsts)) && Number(/max-age=(\d+)/.exec(String(hsts))?.[1] ?? 0) >= 15_552_000,
    "the login page carries HSTS with at least a six month max-age", hsts ?? "absent");
  // A page that pulls in a plain HTTP asset is a page a browser paints half of. The login page
  // carries its own CSS inline precisely so there is nothing to pull in.
  check(!/(?:src|href)\s*=\s*["']http:/i.test(loginHtml), "and it asks for no http asset",
    (/(?:src|href)\s*=\s*["']http:[^"']*/i.exec(loginHtml) ?? ["none"])[0]);
}

const wrong = await postForm("/login", { password: WRONG, next: "/" });
check(wrong.status === 401 && wrong.headers.get("set-cookie") == null,
  "a wrong password is refused and issues no cookie", `HTTP ${wrong.status}, set-cookie ${wrong.headers.get("set-cookie") ?? "none"}`);
// Counted, because the lockout step at the bottom needs to know how many of this address's five
// failures this run has already spent. Nothing here clears them: the throttle resets on a
// successful login, and this gate never types the right password.
let refusals = 1;

// /login is the one route an unauthenticated caller may POST to on a published port, so it does
// not buffer whatever it is sent. The next successful login clears the failure this records.
const oversize = await hit("/login", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
  body: `password=${"a".repeat(64 * 1024)}`,
});
check(oversize.status === 413, "a login body too large to be a password is refused, not buffered", `HTTP ${oversize.status}`);
// A flood of oversized bodies is an attack on this port, so the relay records it as a failure too.
refusals += 1;

// The way in, without the password. A page request carrying the gateway bearer is answered AND
// given a session cookie: holding that token is already full access, so the cookie takes nothing
// away, it puts the access somewhere a browser will keep sending. That is what lets headless
// Chrome below reach a console whose password nobody but Jason knows.
const withBearer = await hit("/", { headers: { accept: "text/html", authorization: `Bearer ${TOKEN}` } });
const setCookie = withBearer.headers.get("set-cookie") ?? "";
const session = /(?:^|,\s*)(gb_session=[^;]+)/.exec(setCookie)?.[1] ?? "";
check(withBearer.status === 200 && session.length > 0,
  "a page request carrying the gateway bearer is served and given a session", `HTTP ${withBearer.status}, cookie ${session.length > 0 ? "set" : "absent"}`);
check(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Max-Age=43200/.test(setCookie),
  "the session cookie is HttpOnly, SameSite=Strict and lasts 12 hours",
  setCookie.replace(/gb_session=[^;]+/, "gb_session=<withheld>") || "no cookie");
// And that mint is for pages only: a script calling /api with the bearer is not handed a session
// it never asked for.
const apiWithBearer = await hit("/api/getHostStatus", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: "{}",
});
check(apiWithBearer.headers.get("set-cookie") == null, "an /api call with the same bearer is given no cookie",
  apiWithBearer.headers.get("set-cookie") ?? "none");

// The injection proof: a session carries no gateway token of its own, so a 200 here can only mean
// the relay added the bearer on the way upstream.
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

step("the job bus edge");
// docs/JOB-BUS.md §9: the only things a deploy gate can say about the bus from outside are that
// its door is shut, that the right key opens it, and that the key opens nothing else. Health is
// authenticated on the public host, so a 200 without a bearer would be the whole bus standing
// open. §10.6 narrowed the closed answer to exactly 401: an unconfigured bus and a wrong key look
// identical from outside, so nobody can probe a deployment to learn whether a token is set yet. A
// 503 here is a relay older than §10.6, which is a finding rather than a pass.
const jobHealth = await hit("/v1/health");
// The bus shares the login lockout (docs/JOB-BUS.md section 10.6): a /v1 request with no bearer is
// one of this address's five failures, and the lockout leg at the bottom counts from `refusals`.
// Without this line the leg tripped one attempt early on every run that reached it.
refusals += 1;
check(jobHealth.status === 401, "GET /v1/health with no bearer is 401, never 200 and never 503",
  `HTTP ${jobHealth.status}${jobHealth.status === 503 ? " (a relay from before §10.6 answers 503 when no token is set)" : ""}`);
if (JOB_TOKEN == null) {
  unresolved("GET /v1/health with the job bus bearer is 200",
    "no --job-token was given, so this gate cannot hold the bus's own credential");
  unresolved("the job bus bearer opens /v1 and nothing else", "the same missing --job-token");
} else {
  const opened = await hit("/v1/health", { headers: { authorization: `Bearer ${JOB_TOKEN}` } });
  const body = await opened.json().catch(() => null);
  check(opened.status === 200 && body?.ok === true,
    "and 200 with the token from --job-token", `HTTP ${opened.status}, queue_depth ${body?.queue_depth ?? "absent"}`);
  // §10.8: a bearer that also opened the console would make every rule inside the bus decorative.
  for (const route of ["/api/listAgents", "/", "/vnc/1/", "/box/surface"]) {
    const answer = await hit(route, { headers: { authorization: `Bearer ${JOB_TOKEN}`, accept: "text/html" } });
    const location = String(answer.headers.get("location") ?? "");
    const refused = answer.status === 401 || answer.status === 403 || answer.status === 404
      || (answer.status >= 300 && answer.status < 400 && location.startsWith("/login"));
    check(refused, `the job bus bearer is refused on ${route}`, `HTTP ${answer.status}${location ? ` -> ${location}` : ""}`);
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
  // The bearer as a header on every request this context makes. A gate cannot type a password
  // nobody but Jason knows, and it does not need to: the relay answers a page request carrying
  // the token and hands back a session, which is what the checks below then run on.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` },
  });
  const page = await context.newPage();
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

  await page.goto(`${URL_BASE}/`, { waitUntil: "load", timeout: 45_000 });
  check(new URL(page.url()).pathname === "/", "a browser carrying the bearer lands on the console, not the login",
    page.url().replace(URL_BASE, ""));
  // And it is holding a session, not riding the header on every request: the cookie is what an
  // EventSource and an iframe carry, and neither of those can add a header of its own.
  const cookies = await context.cookies();
  check(cookies.some((c) => c.name === "gb_session"), "and the browser is holding the session the relay minted",
    cookies.map((c) => c.name).join(", ") || "no cookies");

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
  // AGENTS-CAP-2 and GATE-15, closed rather than moved. This leg asserted the literal `/ 100 bots`
  // and went red the moment somebody deliberately changed the ceiling, which is the bug GATE-15
  // was filed as. Editing the literal to 40 would have relocated it to the next decision, and the
  // ceiling is per workspace now -- the super admin raises one from its client row -- so no literal
  // can be right for every box this gate is ever pointed at.
  //
  // So the gate asks the BOX what its ceiling is and requires the console to AGREE with it. That
  // is the property worth holding: the header a person reads is the number the host will actually
  // refuse at. The number beside it is the bots the console can see rather than countAgents, which
  // also settles the discrepancy described above -- the header no longer reads 0 while a card is on
  // screen, because it counts the cards.
  const capacity = await call("getAgentCapacity", {}, { authorization: `Bearer ${TOKEN}` });
  const maxAgents = Number(capacity.body?.maxAgents);
  const count = await page.evaluate(() => document.querySelector("[data-agent-count]")?.textContent?.trim() ?? "");
  if (!Number.isInteger(maxAgents) || maxAgents < 1) {
    check(false, "the box reports the ceiling its console is drawn against",
      `getAgentCapacity answered HTTP ${capacity.status} ${JSON.stringify(capacity.body ?? capacity.text).slice(0, 160)}`);
  } else {
    check(new RegExp(String.raw`\d+\s*/\s*${maxAgents}\s*bots`).test(count),
      "the roster header shows this box's bots against the ceiling the box reports",
      `header "${count || "empty"}", box says ${maxAgents} (${capacity.body?.bots} bots, ${capacity.body?.remaining} left)`);
  }

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

step("the desktop through the relay's own /vnc route");
// The failure this closes, measured on the R750 before the change: ensureForeverBox answers
// `http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3D3`, and the page used that string as
// its iframe src -- so a browser anywhere but on the box's own machine reached for ITS OWN
// loopback. Jason's Mac runs a box of its own on 6081, so what he got was either his Mac's screen
// or "Failed to connect to downstream server". The frame now comes from the relay, on the page's
// own origin, behind the same login, and the box's noVNC is proxied rather than copied.
let vncProbeId = null;
let vncBrowser = null;
const DESKTOP_DEADLINE = Date.now() + 60_000;
const untilDeadline = async (fn, everyMs = 1000) => {
  for (;;) {
    const value = await fn().catch(() => null);
    if (value != null && value !== false) return value;
    if (Date.now() > DESKTOP_DEADLINE) return null;
    await sleep(everyMs);
  }
};
try {
  const probeName = `probe-vnc-${Math.random().toString(36).slice(2, 7)}`;
  const made = await call("createAgent", {
    name: probeName, description: "", origin: "user", isKickstartRequested: false,
  }, { authorization: `Bearer ${TOKEN}` });
  vncProbeId = (made.body?.agent ?? made.body)?.id ?? null;
  check(vncProbeId != null, "a probe agent for the desktop was created", vncProbeId ?? `HTTP ${made.status}`);

  // The host allocates the screen. Cold that is about thirteen seconds, and the websockify token
  // in the URL it answers with IS the display number.
  const desk = vncProbeId
    ? await call("ensureForeverBox", { id: vncProbeId }, { authorization: `Bearer ${TOKEN}` })
    : { body: {} };
  const hostUrl = String(desk.body?.vncUrl ?? "");
  const display = Number(/token%3D(\d+)/i.exec(hostUrl)?.[1] ?? /token=(\d+)/i.exec(hostUrl)?.[1] ?? 1);
  check(hostUrl.length > 0 && Number.isInteger(display),
    "ensureForeverBox answers with a screen, on the host's own loopback as it always has",
    `box ${desk.body?.state ?? "?"}, display :${display}, host url ${hostUrl || "none"}`);

  const { chromium } = require("playwright-core");
  vncBrowser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await vncBrowser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` },
  });
  const page = await context.newPage();
  await page.goto(`${URL_BASE}/`, { waitUntil: "load", timeout: 45_000 });

  const selected = await untilDeadline(() => page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll(".worker-card[data-context-id]"))
      .find((el) => el.textContent.includes(name));
    if (!card) return null;
    card.click();
    return true;
  }, probeName));
  check(selected === true, "the probe agent is on the roster and can be selected", selected ? probeName : "no card within the deadline");
  await page.waitForTimeout(1200);
  await page.click("#rail-screen .rail-screen-button");

  // One read of the frame, once its document has finished loading. Same origin now, so the parent
  // can see inside it -- which is itself part of the proof: a frame on 127.0.0.1:6081 could not be
  // read from a page on the relay at all.
  const frame = await untilDeadline(() => page.evaluate(() => {
    const el = document.querySelector("iframe[data-box-vnc]");
    if (!el) return null;
    const doc = el.contentDocument;
    if (!doc || doc.readyState === "loading") return null;
    return {
      src: el.getAttribute("src"),
      title: doc.title,
      container: doc.getElementById("noVNC_container") != null,
      canvas: doc.querySelector("#noVNC_container canvas") != null,
    };
  }));
  check(frame != null, "the desktop pane mounts a frame", frame ? "" : "no iframe[data-box-vnc] within the deadline");
  if (frame != null) {
    check(frame.src.startsWith(`${URL_BASE}/vnc/`),
      "the frame is asked for on the page's own origin, under /vnc/, not on the viewer's 127.0.0.1",
      frame.src);
    // noVNC renames the document to the desktop's own name once it is connected, so the title is
    // "<box hostname>:<display> - noVNC" rather than a constant. The substring is the assertion.
    check(/noVNC/.test(frame.title) && frame.container,
      "and what loaded there is the box's own noVNC, served through the relay",
      `title ${JSON.stringify(frame.title)}, #noVNC_container ${frame.container}`);
    // The canvas exists only once RFB has a framebuffer, so this is the client actually connected
    // rather than the page merely loaded.
    const painted = await untilDeadline(() => page.evaluate(() =>
      (document.querySelector("iframe[data-box-vnc]")?.contentDocument?.querySelector("#noVNC_container canvas") != null ? true : null)));
    check(painted === true, "the noVNC client in that frame reached the box and drew its framebuffer",
      painted ? "canvas present" : "no canvas within the deadline");
  }

  // And the websocket half on its own, from the page, so a canvas drawn from cache could not
  // stand in for a live socket. The cookie the relay minted is what authenticates it.
  const socket = await page.evaluate((d) => new Promise((resolve) => {
    const url = `${location.origin.replace(/^http/, "ws")}/vnc/${d}/websockify`;
    const ws = new WebSocket(url);
    const done = (value) => { try { ws.close(); } catch { /* already closing */ } resolve({ url, ...value }); };
    ws.onopen = () => done({ open: true });
    ws.onerror = () => done({ open: false, why: "the socket errored" });
    ws.onclose = (event) => done({ open: false, why: `closed ${event.code}` });
    setTimeout(() => done({ open: ws.readyState === 1, why: `readyState ${ws.readyState}` }), 10_000);
  }), display);
  check(socket.open === true, "a websocket to the relay's /vnc/<display>/websockify reaches open state",
    `${socket.url}${socket.why ? ` -- ${socket.why}` : ""}`);
} catch (error) {
  check(false, "the desktop check ran", String(error?.message ?? error).slice(0, 200));
} finally {
  await vncBrowser?.close().catch(() => {});
  if (vncProbeId) {
    const gone = await call("deleteAgent", { id: vncProbeId }, { authorization: `Bearer ${TOKEN}` }).catch((e) => ({ status: 0, text: String(e) }));
    // Like the probe above, this leaves one permanent id in the box's deleted-agents.json.
    check(gone.status === 200, "the desktop probe agent is deleted", `HTTP ${gone.status}`);
  }
}

// Last, deliberately: a pass here leaves this Mac's address locked out of the login for thirty
// seconds, so nothing that needs to sign in may run after it.
step("the lockout after repeated wrong passwords");
// Five failures per source address. The login step above already spent some of them and there is
// no way back: the counter resets on a successful login, which this gate cannot perform. So what
// is asserted is the rule -- refusals until the fifth, then the limiter -- counted from where the
// run actually is rather than from a fixed six.
const left = Math.max(0, 5 - refusals);
const attempts = [];
for (let i = 0; i <= left; i += 1) attempts.push((await postForm("/login", { password: `${WRONG}-${i}` })).status);
check(attempts.slice(0, left).every((s) => s === 401) && attempts[left] === 429,
  `${left} more wrong passwords are refused and the next is rate limited`,
  `${attempts.join(" ")} (${refusals} of the five failures were already spent above)`);
// The lockout is not a filter on wrong passwords, it is a stop on the source, so the right one has
// to be refused too or a guesser just alternates.
// The lockout is a stop on the SOURCE, not a verdict on the password, and this gate does not know
// the right password to prove that the direct way. It proves it sideways instead: an oversized
// body answered 413 a moment ago, because the relay read the body and found it too large. Under a
// lockout the same request answers 429, which it can only do by refusing the address before it
// looks at anything the caller sent.
const duringLockout = await hit("/login", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
  body: `password=${"a".repeat(64 * 1024)}`,
});
check(duringLockout.status === 429, "a request that would otherwise be a 413 is refused unread while the lockout holds",
  `HTTP ${duringLockout.status}, was 413 before the lockout`);
check(Number(duringLockout.headers.get("retry-after") ?? 0) > 0 && Number(duringLockout.headers.get("retry-after")) <= 30,
  "the response says how long to wait", `retry-after ${duringLockout.headers.get("retry-after")}s`);
if (EXTERNAL) {
  // The forged header, and what this check is and is not worth.
  //
  // Traefik rewrites the X-Forwarded-* family from the connection it actually accepted: measured
  // against traefik:v3.6 started with this server's own arguments, "X-Forwarded-For: 1.2.3.4,
  // 5.6.7.8, 9.9.9.9" reached the backend as a single hop that was the caller's real address. So
  // through a live chain this asserts the CHAIN sanitizes, not that the relay would have. The
  // relay's own half is proved in tests/relay-trusted-proxies.test.mjs, which drives the address
  // logic directly with peers this gate cannot spoof from the outside. Both halves matter, and
  // this one is the one that can only be seen from here.
  const forged = await hit("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", "x-forwarded-for": "203.0.113.7" },
    body: new URLSearchParams({ password: `${WRONG}-forged` }).toString(),
  });
  check(forged.status === 429, "a forged X-Forwarded-For lands in the same lockout bucket, so it buys nothing",
    `HTTP ${forged.status}${forged.status === 401 ? " -- the forged hop was believed, which is the bug this checks for" : ""}`);
  const secondForgery = await hit("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", "x-forwarded-for": "198.51.100.42, 203.0.113.7" },
    body: new URLSearchParams({ password: `${WRONG}-forged-2` }).toString(),
  });
  check(secondForgery.status === 429, "and so does a second, different one",
    `HTTP ${secondForgery.status}`);

  // And the check the one above cannot make: the guesser's real path.
  //
  // CF-Connecting-IP is not in the X-Forwarded-* family, so Traefik passes it through byte for
  // byte. Sent through Cloudflare it is worthless to a guesser, because Cloudflare overwrites it
  // before Traefik ever sees it -- which is exactly why a forgery aimed at the front door proves
  // nothing. Nothing forces anyone through the front door. The origin address is in certificate
  // transparency and is shared with every other site on the host, so the request below goes
  // straight there, with the right SNI and Host and a CF-Connecting-IP this gate invented, and a
  // different one each time.
  //
  // Two outcomes are a pass and they are different sentences. If the origin answers, the request
  // has to land in the same bucket as everything above -- this Mac's own address, which Traefik
  // reports and no header can change -- and answer 429. If the origin refuses the connection
  // outright, the bypass does not exist to be tested, which is a stronger result than passing it.
  // Only "the origin answered 401" is a failure, and it means a guesser has unlimited attempts.
  step(`the origin behind the proxy, at ${ORIGIN_IP}`);
  const hostname = new URL(URL_BASE).hostname;
  const direct = (forgedIp) => new Promise((resolve) => {
    const body = new URLSearchParams({ password: `${WRONG}-origin-${forgedIp}` }).toString();
    const req = https.request({
      host: ORIGIN_IP,
      port: 443,
      servername: hostname,
      path: "/login",
      method: "POST",
      // rejectUnauthorized stays on: a certificate this Mac would not accept is a different
      // finding, and it would be reported as a refused connection rather than hidden.
      rejectUnauthorized: true,
      headers: {
        host: hostname,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        "content-length": Buffer.byteLength(body),
        "cf-connecting-ip": forgedIp,
      },
    }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    // The code matters as much as the message. ECONNREFUSED and its neighbours are the ORIGIN
    // answering "no"; a timeout, a DNS failure or a certificate this Mac would not accept are
    // this end failing, and they say nothing whatever about whether a guesser somewhere else can
    // reach 66.90.191.45 on 443. Round one of this gate treated all of them alike and printed a
    // certificate mismatch as proof the bypass did not exist.
    req.setTimeout(15_000, () => { req.destroy(); resolve({ status: 0, code: "ETIMEDOUT", why: "timed out" }); });
    req.on("error", (error) => resolve({ status: 0, code: error.code ?? "ERR", why: error.message }));
    req.end(body);
  });
  const LABEL = "a forged CF-Connecting-IP sent straight to the origin does not escape the lockout";
  // An IP literal as the base cannot be tested this way and must not be reported as if it had
  // been. The request would carry that literal as SNI and Host to a different address, so every
  // outcome is about the certificate rather than about the lockout.
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) {
    unresolved(LABEL, `the base URL names ${hostname} rather than a hostname, so a request to `
      + `${ORIGIN_IP} carrying it would be judged by the certificate and not by the lockout`);
  } else {
    const bypass = [];
    for (const forgedIp of ["203.0.113.11", "203.0.113.12", "203.0.113.13"]) bypass.push(await direct(forgedIp));
    // The three outcomes, in the order they matter. Answered and rate limited: the forged header
    // bought nothing and the guesser is in this Mac's own bucket. Refused at the TCP level: the
    // origin itself turned the connection away, which is a stronger result than passing the test.
    // Anything else -- a timeout, a name that would not resolve, a certificate this Mac declines
    // -- happened on this end and decides nothing.
    const REFUSED = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);
    const allLimited = bypass.every((r) => r.status === 429);
    const allRefused = bypass.every((r) => r.status === 0 && REFUSED.has(r.code));
    const answered = bypass.filter((r) => r.status !== 0);
    const seen = bypass.map((r) => (r.status !== 0 ? `HTTP ${r.status}` : `${r.code} ${r.why}`)).join("; ");
    if (allLimited || allRefused) {
      check(true, LABEL, allRefused
        ? `the origin refused every connection at the transport (${bypass[0].code}), so there is no bypass to take`
        : `${seen} -- every attempt landed in this Mac's own lockout bucket`);
    } else if (answered.length > 0) {
      check(false, LABEL, `${seen}${answered.some((r) => r.status === 401)
        ? " -- a 401 means the forged header was believed and a guesser has unlimited attempts" : ""}`);
    } else {
      unresolved(LABEL, `${seen} -- that is this Mac failing to reach ${ORIGIN_IP}, not the origin `
        + "refusing anyone; run this again from a host that can reach it");
    }
  }
}

// The bearer is not the login, so the lockout must not reach the gates themselves.
const gateDuringLockout = await call("getHostStatus", {}, { authorization: `Bearer ${TOKEN}` });
check(gateDuringLockout.status === 200, "the gateway bearer still works while a login lockout holds", `HTTP ${gateDuringLockout.status}`);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)`
  + `${inconclusive > 0 ? `, ${inconclusive} inconclusive` : ""}  ${URL_BASE}`);
process.exit(failures === 0 ? 0 : 1);
