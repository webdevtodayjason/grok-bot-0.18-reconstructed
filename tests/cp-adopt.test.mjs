// SUPPORT-1d: `tenant adopt` leaves a row the relay can actually serve, or it does not finish.
//
// WHAT THIS IS ABOUT, MEASURED ON THE R750 2026-09-13. `titanium` is Jason's own console and the one
// workspace this service did not build, so it is an ADOPTED row. It was claimed without --box, which
// left `box_container` NULL, and no gateway token for it existed anywhere this service reads. The
// first three support mails ever to arrive at support@titanium.bot were stored and told nobody: the
// desk answered "no container name on its row", then "gateway token could not be read". An operator
// repaired it by writing a database column and a 0600 file on a live server by hand, and anything
// done by hand on a live instance has to become a mechanism.
//
// So the verb now:
//   - writes the container name from --box or from the Coolify uuid, through the one helper every
//     reader in the service shares,
//   - takes the gateway token on STDIN and never in an argument, because an argument is in the shell
//     history, in `ps` output and in the scrollback of whoever is watching, and this one opens a
//     customer's whole box,
//   - and REFUSES TO FINISH without either that flag or a token already on the disk, saying which.
//
// THE CLI IS RUN AS A PROCESS here rather than imported, because cp/cli.mjs is a script that dispatches
// on process.argv at import. That is also what makes the stdin rule testable at all: a piped token and
// an argument are different things only to a real process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { adoptedProfileDirDefault, gatewayTokenFileIn } from "../cp/provision.mjs";
import { startControlPlane } from "./cp-support.mjs";

const CLI = path.join(import.meta.dirname, "../cp/cli.mjs");
const UUID = "p927bfqm83ioloibamlvyd7g";
const TOKEN = "a-real-looking-gateway-token-0f3a9c";

/**
 * The CLI, against a control plane that is really listening, with the token on stdin when there is one.
 *
 * The environment is the service's own: the same admin bearer, the same release root, the same tenant
 * root. That matters for one reason beyond convenience -- the verb decides where the token file will be
 * BEFORE it calls the route, and on the R750 the CLI runs inside the control plane's own container, so
 * the two agree because they read one environment.
 */
function runCli(plane, args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        CP_PUBLIC_URL: plane.base,
        CP_ADMIN_TOKEN: plane.config.adminToken,
        CP_DATA_DIR: plane.config.dataDir,
        CP_TENANT_ROOT: plane.config.tenantRoot,
        CP_RELEASE_ROOT: plane.config.releaseRoot,
        CP_BASE_DOMAIN: "titanium.bot",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    if (stdin === null) child.stdin.end();
    else child.stdin.end(String(stdin));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function withPlane(run, { env = {} } = {}) {
  const plane = await startControlPlane({ env });
  try { await run(plane); }
  finally { await plane.dispose(); }
}

test("a token on stdin is written 0600 and the row carries the container name Coolify gives it", async () => {
  await withPlane(async (plane) => {
    const answer = await runCli(plane, ["tenant", "adopt", "titanium", UUID, "console.titanium.bot", "--gateway-token-stdin"], { stdin: `${TOKEN}\n` });
    assert.equal(answer.code, 0, `${answer.out}\n${answer.err}`);

    const file = gatewayTokenFileIn(adoptedProfileDirDefault(plane.config));
    assert.equal(existsSync(file), true, `no token file at ${file}: ${answer.out}`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).token, TOKEN);
    assert.equal(statSync(file).mode & 0o777, 0o600, "a gateway token opens a customer's whole box");

    const row = plane.store.getTenant("titanium");
    assert.equal(row.status, "adopted");
    assert.equal(row.coolifyServiceUuid, UUID);
    // THE COLUMN, WRITTEN. This is what was NULL on the R750, and it is what the support desk, the
    // onboarding sequence and the Box health panel all read.
    assert.equal(row.boxContainer, `titanbot-box-${UUID}`);

    // THE VALUE IS NEVER PRINTED. The path and the mode are, because an operator has to know where it
    // went, and the token is the one thing that must not end up in a terminal somebody scrolls back.
    assert.equal(answer.out.includes(TOKEN), false, answer.out);
    assert.equal(answer.err.includes(TOKEN), false, answer.err);
    assert.match(answer.out, /gateway token is now at .*local-docker-vm\.json, 0600/);
  });
});

test("--box still wins over the derived name, because a re-provision mints a new uuid", async () => {
  await withPlane(async (plane) => {
    const answer = await runCli(
      plane,
      ["tenant", "adopt", "titanium", UUID, "console.titanium.bot", "--box", "titanbot-box-operator", "--gateway-token-stdin"],
      { stdin: TOKEN },
    );
    assert.equal(answer.code, 0, `${answer.out}\n${answer.err}`);
    assert.equal(plane.store.getTenant("titanium").boxContainer, "titanbot-box-operator");
  });
});

test("an adopt with no token and none on disk is refused, and NOTHING is claimed", async () => {
  await withPlane(async (plane) => {
    const answer = await runCli(plane, ["tenant", "adopt", "titanium", UUID, "console.titanium.bot"]);
    assert.notEqual(answer.code, 0, answer.out);
    // IT SAYS WHICH of the two ways is missing, and names the file it looked for.
    assert.match(answer.err, /there is no gateway token at .*local-docker-vm\.json/);
    assert.match(answer.err, /--gateway-token-stdin/);
    assert.match(answer.err, /nothing was done/);
    // A refused adopt has to be indistinguishable from never having asked.
    assert.equal(plane.store.getTenant("titanium"), null);
    assert.deepEqual(plane.store.listSteps("titanium"), []);
  });
});

test("an adopt with a token already on disk finishes and says one is there", async () => {
  await withPlane(async (plane) => {
    const profileDir = adoptedProfileDirDefault(plane.config);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(gatewayTokenFileIn(profileDir), JSON.stringify({ token: "written-by-the-operator-earlier" }), { mode: 0o600 });
    const answer = await runCli(plane, ["tenant", "adopt", "titanium", UUID, "console.titanium.bot"]);
    assert.equal(answer.code, 0, `${answer.out}\n${answer.err}`);
    assert.match(answer.out, /one is already there/);
    assert.equal(plane.store.getTenant("titanium").status, "adopted");
    // And it was not overwritten.
    assert.equal(JSON.parse(readFileSync(gatewayTokenFileIn(profileDir), "utf8")).token, "written-by-the-operator-earlier");
  });
});

test("an empty pipe is refused before anything is claimed", async () => {
  await withPlane(async (plane) => {
    const answer = await runCli(plane, ["tenant", "adopt", "titanium", UUID, "console.titanium.bot", "--gateway-token-stdin"], { stdin: "" });
    assert.notEqual(answer.code, 0, answer.out);
    assert.match(answer.err, /no gateway token on stdin, nothing was done/);
    assert.equal(plane.store.getTenant("titanium"), null, "an empty pipe claimed a workspace");
    assert.equal(existsSync(gatewayTokenFileIn(adoptedProfileDirDefault(plane.config))), false);
  });
});

test("the token cannot be handed over as an argument", async () => {
  await withPlane(async (plane) => {
    // What somebody does on the first try. The flag takes no value, so the token sits in argv as a
    // stray positional, stdin is empty, and the verb refuses rather than quietly reading it out of the
    // command line where `ps` and the shell history can both see it.
    const answer = await runCli(plane, ["tenant", "adopt", "titanium", UUID, "console.titanium.bot", "--gateway-token-stdin", TOKEN], { stdin: "" });
    assert.notEqual(answer.code, 0, answer.out);
    assert.match(answer.err, /no gateway token on stdin/);
    assert.equal(existsSync(gatewayTokenFileIn(adoptedProfileDirDefault(plane.config))), false,
      "a token read off the command line was written to disk");
  });
});

test("a token with a space in the middle of it is refused as two things", async () => {
  await withPlane(async (plane) => {
    const answer = await runCli(plane, ["tenant", "adopt", "titanium", UUID, "console.titanium.bot", "--gateway-token-stdin"], { stdin: "half of it\nand the rest\n" });
    assert.notEqual(answer.code, 0, answer.out);
    assert.match(answer.err, /not one token; nothing was done/);
    assert.equal(plane.store.getTenant("titanium"), null);
  });
});

test("a --profile directory is where the token goes, because that is where the registry reads it", async () => {
  // The relay's own door needs its own credential. CP_RELAY_TOKEN is NOT the admin token and neither
  // opens the other's routes, so the registry read at the end of this case has to carry it.
  await withPlane(async (plane) => {
    const elsewhere = path.join(plane.root, "somewhere-else", "profile");
    mkdirSync(elsewhere, { recursive: true });
    const answer = await runCli(
      plane,
      ["tenant", "adopt", "titanium", UUID, "console.titanium.bot", "--profile", elsewhere, "--gateway-token-stdin"],
      { stdin: TOKEN },
    );
    assert.equal(answer.code, 0, `${answer.out}\n${answer.err}`);
    assert.equal(JSON.parse(readFileSync(gatewayTokenFileIn(elsewhere), "utf8")).token, TOKEN);
    assert.equal(existsSync(gatewayTokenFileIn(adoptedProfileDirDefault(plane.config))), false,
      "the token went to the default directory instead of the one the adoption named, which is a file nothing reads");

    // And the registry serves the row, which is the whole point of the verb: one adopted workspace the
    // relay can talk to. THIS is the read that used to come back empty.
    const registry = await plane.request("GET", "/v1/relay/tenants", { token: plane.config.relayToken });
    assert.equal(registry.status, 200, registry.text);
    const served = (registry.body.tenants ?? []).find((one) => one.slug === "titanium");
    assert.ok(served, `titanium was skipped: ${JSON.stringify(registry.body.skipped ?? [])}`);
    assert.equal(served.token, TOKEN);
    assert.equal(served.box, `titanbot-box-${UUID}`);
  }, { env: { CP_RELAY_TOKEN: "a-relay-token-for-this-test" } });
});
