// TENANT-5, the whole point of it: ONE relay, ONE console, ONE login page, and two customers on it
// who cannot see each other.
//
// Everything the relay does used to read a module-level constant -- one BOX, one GATEWAY, one
// TOKEN, one endpoints.json. This measures that those are gone: two workspaces are stood up with a
// real gateway each on its own port, and a request carrying one workspace's session is watched to
// see that it reaches that workspace's gateway with that workspace's bearer and writes into that
// workspace's directory, while the other gateway sees nothing at all.
//
// The failures worth naming, because each of them looks like working software from one browser:
//   - the roster: a customer opening the console and seeing another customer's agents;
//   - the bearer: this relay forwarding one workspace's gateway token to another's box;
//   - the files: two customers saving endpoints over each other in a shared release directory;
//   - the operator: Jason's own console quietly resolving to a customer's box after the change;
//   - the stranger: a signed cookie naming a workspace that does not exist getting anything but a
//     plain sentence.
// There is an assertion below for each.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSession, newAuthRecord, readSession, writeAuthFile } from "../ui/auth.mjs";
import { signSvix } from "../ui/mail-edge.mjs";
import {
  RELAY_TOKEN, cookieOf, form, keyFor, signInAsOperator, signInAsTenant, startRelay,
  startRelayWithLinks, tenantRow, tenantsFile, tokenFor,
} from "./relay-tenant-support.mjs";

// A gateway that answers the handful of routes the relay forwards, and remembers every call it saw
// with the bearer it arrived on. That record is the evidence: a leak between two workspaces shows
// up here as a call on the wrong server or the wrong token on the right one.
function startFakeGateway(label) {
  const calls = [];
  const server = createServer((req, res) => {
    const authorization = String(req.headers.authorization ?? "");
    calls.push({ method: req.method, url: req.url, authorization });
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, gateway: label }));
    }
    if (req.url?.startsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ gateway: label })}\n\n`);
      return res.end();
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      // The roster is the thing a person sees on the console, so it is what these tests read.
      res.end(JSON.stringify({ gateway: label, agents: [{ id: `${label}-1`, name: `${label} agent` }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      label,
      url: `http://127.0.0.1:${server.address().port}`,
      calls,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

// One console, the operator plus two customers, each customer with a gateway and a directory of
// its own. No docker on PATH, so the box-name verification learns nothing and every row is taken at
// its word; a row that is deliberately unreachable is its own test at the bottom of this file.
async function startConsole() {
  const [gwA, gwB, gwOperator] = await Promise.all([
    startFakeGateway("alpha"), startFakeGateway("beta"), startFakeGateway("operator"),
  ]);
  const alpha = tenantRow("alpha", { gateway: gwA.url, token: "alpha-gateway-token" });
  const beta = tenantRow("beta", { gateway: gwB.url, token: "beta-gateway-token" });
  // startRelayWithLinks and not startRelay: since ONBOARD-5 every /login?sso= click is checked with the
  // control plane, so a console that cannot reach one refuses every link, and signInAsTenant is a link.
  const relay = await startRelayWithLinks({
    SAND_HOST_GATEWAY_URL: gwOperator.url,
    SAND_HOST_GATEWAY_TOKEN: "operator-gateway-token",
    SAND_UI_TENANTS_FILE: tenantsFile([alpha.row, beta.row]),
  }, { prefix: "relay-one-console-", pathValue: "/nonexistent" });
  const stop = async () => {
    relay.stop();
    await Promise.all([gwA.stop(), gwB.stop(), gwOperator.stop()]);
  };
  return { relay, alpha, beta, gwA, gwB, gwOperator, stop };
}

test("two customers on one console reach their own box, their own token and their own files", async () => {
  const c = await startConsole();
  try {
    assert.match(c.relay.boot, /work 3: /);

    const cookieA = await signInAsTenant(c.relay, "alpha");
    const cookieB = await signInAsTenant(c.relay, "beta");
    // Two sessions, two workspaces, and the cookie is where that is written down.
    assert.notEqual(cookieA, cookieB);

    // 1. THE ROSTER. Each session sees its own gateway's agents and never the other's.
    const rosterA = await (await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA }, body: "{}",
    })).json();
    assert.equal(rosterA.gateway, "alpha");
    const rosterB = await (await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: "{}",
    })).json();
    assert.equal(rosterB.gateway, "beta");

    // 2. THE BEARER. Alpha's gateway only ever saw alpha's token, and beta's only beta's. This is
    //    the assertion that a shared upstreamHeaders() would fail.
    const alphaCalls = c.gwA.calls.filter((call) => call.url === "/api/listAgents");
    const betaCalls = c.gwB.calls.filter((call) => call.url === "/api/listAgents");
    assert.equal(alphaCalls.length, 1);
    assert.equal(betaCalls.length, 1);
    assert.equal(alphaCalls[0].authorization, "Bearer alpha-gateway-token");
    assert.equal(betaCalls[0].authorization, "Bearer beta-gateway-token");
    for (const call of c.gwA.calls) assert.equal(call.authorization.includes("beta"), false);
    for (const call of c.gwB.calls) assert.equal(call.authorization.includes("alpha"), false);
    // And the operator's box was not touched by either customer.
    assert.equal(c.gwOperator.calls.length, 0);

    // 3. THE FILES. Alpha saves an endpoint; it lands in alpha's state directory and nowhere else.
    const saved = await fetch(`${c.relay.base}/endpoints`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ endpoints: [{ id: "e", name: "e", baseUrl: "https://93.184.216.34/v1", model: "m", apiKey: "alpha-secret-key" }] }),
    });
    assert.equal(saved.status, 200);
    const alphaFile = readFileSync(path.join(c.alpha.state, "endpoints.json"), "utf8");
    assert.match(alphaFile, /alpha-secret-key/);
    for (const [file, whose] of [[path.join(c.beta.state, "endpoints.json"), "beta"], [c.relay.catalog, "the operator"]]) {
      let written = "";
      try { written = readFileSync(file, "utf8"); } catch { written = ""; }
      assert.equal(written, "", `alpha's save reached ${whose}'s catalog`);
    }
    // And beta reading the list back does not see alpha's row or alpha's key.
    const listB = await (await fetch(`${c.relay.base}/endpoints`, { headers: { cookie: cookieB, accept: "application/json" } })).json();
    assert.deepEqual(listB.endpoints, []);
    const listA = await (await fetch(`${c.relay.base}/endpoints`, { headers: { cookie: cookieA, accept: "application/json" } })).json();
    assert.equal(listA.endpoints.length, 1);
    // The key is never handed back to the browser that set it, either.
    assert.equal(listA.endpoints[0].apiKey, "set");

    // 4. THE STREAM AND THE HEALTH ROUTE go to the same box as everything else.
    const events = await fetch(`${c.relay.base}/events`, { headers: { cookie: cookieB, accept: "text/event-stream" } });
    assert.equal(events.status, 200);
    assert.match(await events.text(), /"gateway":"beta"/);
    const health = await (await fetch(`${c.relay.base}/health`, { headers: { cookie: cookieA } })).json();
    assert.equal(health.gateway, "alpha");
  } finally { await c.stop(); }
});

test("the operator's own door still means the operator's own box", async () => {
  const c = await startConsole();
  try {
    // The instance password, which is the door Jason has always used.
    const operator = await signInAsOperator(c.relay);
    const roster = await (await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json", cookie: operator }, body: "{}",
    })).json();
    assert.equal(roster.gateway, "operator");
    assert.equal(c.gwOperator.calls[0].authorization, "Bearer operator-gateway-token");
    assert.equal(c.gwA.calls.length, 0);
    assert.equal(c.gwB.calls.length, 0);

    // And the gateway bearer is the operator's too: holding it is already full access to the
    // operator's box, and it must not be a way into anybody else's.
    const byBearer = await (await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-gateway-token" },
      body: "{}",
    })).json();
    assert.equal(byBearer.gateway, "operator");

    // A CUSTOMER's gateway token is a credential for their own box and must not open this console.
    const asCustomer = await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer alpha-gateway-token" },
      body: "{}",
    });
    assert.equal(asCustomer.status, 401, "a customer's box token opened the console");
    assert.equal(asCustomer.headers.get("x-relay-auth"), "required");
    assert.equal(c.gwA.calls.length, 0, "a refused request still reached a box");

    // The operator's own files are the ones the operator writes, out of the state directory the
    // operator's environment names rather than out of a customer's.
    const saved = await fetch(`${c.relay.base}/endpoints`, {
      method: "POST", headers: { "content-type": "application/json", cookie: operator },
      body: JSON.stringify({ endpoints: [{ id: "o", name: "o", baseUrl: "http://titanbot-box:1340", model: "m", apiKey: "operator-key" }] }),
    });
    assert.equal(saved.status, 200);
    assert.match(readFileSync(c.relay.catalog, "utf8"), /operator-key/);
    for (const state of [c.alpha.state, c.beta.state]) {
      let written = "";
      try { written = readFileSync(path.join(state, "endpoints.json"), "utf8"); } catch { written = ""; }
      assert.equal(written, "", "the operator's save reached a customer's catalog");
    }
  } finally { await c.stop(); }
});

test("a session naming a workspace this console does not serve gets a sentence, not a box", async () => {
  const c = await startConsole();
  try {
    // A cookie signed with THIS console's own cookie secret, naming a workspace that does not
    // exist. That is the shape a customer's session takes the moment their workspace is deleted, and
    // the shape a stranger's takes if they ever got hold of the cookie secret. Either way the
    // answer is a page and a plain sentence, and nothing behind it is reached.
    const record = JSON.parse(readFileSync(path.join(c.relay.dir, "auth.json"), "utf8"));
    const forged = createSession(record.cookieSecret, { tenant: "a-workspace-that-was-deleted" });
    const answer = await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html", cookie: `gb_session=${forged}` },
      body: "{}",
    });
    assert.equal(answer.status, 503);
    assert.match(await answer.text(), /That workspace is not available right now\./);
    assert.equal(c.gwA.calls.length, 0);
    assert.equal(c.gwB.calls.length, 0);
    assert.equal(c.gwOperator.calls.length, 0);

    // The cookie is deliberately NOT cleared. A workspace is unknown while it is being built and
    // during a control plane outage, and signing a customer out over a state that mends itself in
    // sixty seconds is worse than the sentence.
    assert.equal(cookieOf(answer), "");

    // And a workspace this console DOES serve is unaffected by any of that.
    const cookieA = await signInAsTenant(c.relay, "alpha");
    const roster = await (await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA }, body: "{}",
    })).json();
    assert.equal(roster.gateway, "alpha");
  } finally { await c.stop(); }
});

test("the cookie carries the workspace, and an old cookie without one is the operator", async () => {
  const c = await startConsole();
  try {
    const record = JSON.parse(readFileSync(path.join(c.relay.dir, "auth.json"), "utf8"));

    // What the account door writes: the workspace off the VERIFIED token, never off the form.
    const cookieA = await signInAsTenant(c.relay, "alpha");
    const payload = readSession(cookieA.slice("gb_session=".length), record.cookieSecret);
    assert.equal(payload.tenant, "alpha");

    // What the instance password writes.
    const operator = await signInAsOperator(c.relay);
    assert.equal(readSession(operator.slice("gb_session=".length), record.cookieSecret).tenant, "titanium");

    // A cookie minted before TENANT-5 shipped carries no tenant claim at all. It has to keep
    // working and it has to mean the operator, or the deploy signs Jason out of his own console.
    const old = createSession(record.cookieSecret);
    assert.equal(readSession(old, record.cookieSecret).tenant, undefined);
    const roster = await (await fetch(`${c.relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json", cookie: `gb_session=${old}` }, body: "{}",
    })).json();
    assert.equal(roster.gateway, "operator");
  } finally { await c.stop(); }
});

test("the job bus bearer picks the workspace, so one customer's jobs reach one customer's box", async () => {
  const c = await startConsole();
  try {
    writeFileSync(path.join(c.alpha.profile, "job-bus.json"), JSON.stringify({ token: "alpha-job-bus-bearer-of-some-length" }));
    writeFileSync(path.join(c.beta.profile, "job-bus.json"), JSON.stringify({ token: "beta-job-bus-bearer-of-some-length" }));

    const health = async (bearer) => fetch(`${c.relay.base}/v1/health`, { headers: { authorization: `Bearer ${bearer}` } });

    assert.equal((await health("alpha-job-bus-bearer-of-some-length")).status, 200);
    assert.equal((await health("beta-job-bus-bearer-of-some-length")).status, 200);
    const alphaBus = c.gwA.calls.filter((call) => call.url === "/api/jobBusHealth");
    const betaBus = c.gwB.calls.filter((call) => call.url === "/api/jobBusHealth");
    assert.equal(alphaBus.length, 1);
    assert.equal(betaBus.length, 1);
    assert.equal(alphaBus[0].authorization, "Bearer alpha-gateway-token");
    assert.equal(betaBus[0].authorization, "Bearer beta-gateway-token");
    // Neither bearer reached the other's box, and neither reached the operator's.
    assert.equal(c.gwOperator.calls.filter((call) => call.url === "/api/jobBusHealth").length, 0);

    // A bearer nobody holds is the same 401 it always was, and it reaches no box at all.
    const stranger = await health("a bearer nobody on this console holds");
    assert.equal(stranger.status, 401);
    assert.equal(c.gwA.calls.filter((call) => call.url === "/api/jobBusHealth").length, 1);
    assert.equal(c.gwB.calls.filter((call) => call.url === "/api/jobBusHealth").length, 1);
  } finally { await c.stop(); }
});

test("the host bundle route matches a box token to its own workspace, and a stranger gets 404", async () => {
  const c = await startConsole();
  try {
    // The credential on this route is the token in the path, because the caller is a box's own host
    // process which can hold neither a cookie nor a header. Under TENANT-5 that token also says
    // WHICH box, so a wrong one must be a 404 rather than a bundle composed in a neighbour.
    //
    // With no runtime directory configured the route stops at 503, which is exactly the answer that
    // proves the token matched: a token that did not match never gets that far.
    const known = await fetch(`${c.relay.base}/runtime/alpha-gateway-token/sand-host-bundle-latest.version`);
    assert.equal(known.status, 503, "a known box token must get past the credential check");
    const stranger = await fetch(`${c.relay.base}/runtime/a-token-no-box-here-holds/sand-host-bundle-latest.version`);
    assert.equal(stranger.status, 404, "an unknown token must not be told the path exists");
    // A 404 rather than a 401 on purpose: a refusal that told "wrong token" apart from "no such
    // file" would confirm the route exists to anyone who found it.
    assert.match(String((await stranger.json()).error), /not found/);
  } finally { await c.stop(); }
});

test("a workspace whose box is not running answers the sentence rather than reaching a neighbour", async () => {
  // The dangerous version of this used to be a fallback: when the configured container name did not
  // resolve, the relay took the FIRST container carrying com.titanbot.role=box. On a host with two
  // customers that is an arbitrary customer's box, and every docker exec the console makes would
  // land in it. The fallback is deleted, and this is the answer that replaced it.
  const [gw] = await Promise.all([startFakeGateway("alpha")]);
  const alpha = tenantRow("alpha", { gateway: gw.url, token: "alpha-gateway-token", box: "a-container-that-is-not-running" });
  // docker present and answering: the name check runs, finds nothing by that name, and marks the
  // workspace unavailable. `docker` here is a stub that lists one container, and it is not alpha's.
  const stub = path.join(alpha.root, "bin");
  const { mkdirSync, chmodSync } = await import("node:fs");
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, "docker"), "#!/bin/sh\ncase \"$1\" in\n  ps) echo somebody-elses-box ;;\n  version) echo 27.0.0 ;;\n  *) exit 1 ;;\nesac\n");
  chmodSync(path.join(stub, "docker"), 0o755);

  const relay = await startRelayWithLinks({
    SAND_HOST_GATEWAY_URL: gw.url, SAND_HOST_GATEWAY_TOKEN: "operator-gateway-token",
    SAND_UI_TENANTS_FILE: tenantsFile([alpha.row]),
    PATH: `${stub}:/usr/bin:/bin`,
  }, { prefix: "relay-unreachable-" });
  try {
    assert.match(relay.boot, /alpha: no container named a-container-that-is-not-running/);
    assert.match(relay.boot, /alpha \(box not running\)/);
    // Signing in with a link for it gets the sentence rather than a session, and nothing behind it
    // is reached.
    const answer = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor("alpha", keyFor("alpha")))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(answer.status, 503);
    assert.equal(cookieOf(answer), "");
    assert.match(await answer.text(), /That workspace is not available right now\./);
    assert.equal(gw.calls.length, 0);

    // The OPERATOR is deliberately exempt from being marked unavailable: this console is the door
    // the operator fixes a stopped box from, and locking it would be the worse failure. It says so
    // in the log instead.
    assert.match(relay.boot, /Set SAND_BOX_CONTAINER on this relay/);
    const operator = await fetch(`${relay.base}/login`, form({ password: "an instance password no test types" }));
    assert.equal(operator.status, 302);
    assert.ok(cookieOf(operator).length > 0, "the operator must not be locked out of a console over a stopped box");
  } finally { relay.stop(); await gw.stop(); }
});

test("the mail webhook finds the workspace by the recipient's domain, and verifies with its secret", async () => {
  // /hooks/resend is one public door for every workspace and it carries no session and no bearer:
  // its credential is the Svix signature, and the signing secret is per workspace. So the workspace
  // has to be chosen BEFORE anything is verified, and the contract's offer -- one shared domain,
  // unique agent name -- is not sound, because agent names are not unique across customers and the
  // moment two of them each have a Titan, titan@titanium.bot is ambiguous.
  //
  // Routing by DOMAIN is. A domain is verified inside exactly one Resend account, so a tie is
  // impossible, and the claim only picks the secret: the secret then has to check out, which is the
  // same shape ui/session-token.mjs already uses for the tenant claim on a token.
  const c = await startConsole();
  try {
    writeFileSync(path.join(c.alpha.state, "mail.json"), JSON.stringify({
      enabled: true, domain: "alpha.example", webhookSecret: "YWxwaGEtd2ViaG9vay1zZWNyZXQ=",
    }));
    // Receiving is switched OFF for beta on purpose. "disabled" is an answer only a caller that
    // proved it was Resend is given, so reading it back is proof that BETA's secret verified the
    // signature -- which is proof beta was the workspace chosen.
    writeFileSync(path.join(c.beta.state, "mail.json"), JSON.stringify({
      enabled: false, domain: "beta.example", webhookSecret: "YmV0YS13ZWJob29rLXNlY3JldA==",
    }));

    const post = async (to, secret) => {
      const raw = JSON.stringify({ type: "email.received", data: { email_id: `m-${to}`, to: [to], from: "somebody@example.com" } });
      const headers = { id: "msg_1", timestamp: String(Math.floor(Date.now() / 1000)) };
      return fetch(`${c.relay.base}/hooks/resend`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": headers.id, "svix-timestamp": headers.timestamp,
          "svix-signature": signSvix(secret, headers, raw),
        },
        body: raw,
      });
    };

    const toBeta = await post("titan@beta.example", "YmV0YS13ZWJob29rLXNlY3JldA==");
    assert.equal(toBeta.status, 200);
    assert.deepEqual(await toBeta.json(), { ignored: "disabled" },
      "the domain must pick beta, and beta's own secret must be the one that verified");

    // The same address signed with ALPHA's secret. The domain still picks beta, beta's secret does
    // not verify it, and it is refused. If the domain were being ignored and the first workspace
    // with a good signature were being taken, this would have been accepted.
    const forged = await post("titan@beta.example", "YWxwaGEtd2ViaG9vay1zZWNyZXQ=");
    assert.equal(forged.status, 401);
    assert.deepEqual(await forged.json(), { error: "invalid_signature" });

    // A domain nobody on this console owns. 200 with a reason, never a retry: a webhook that
    // answers anything else is one Resend brings back for hours over a decision made on purpose.
    const stray = await post("titan@nobody.example", "YWxwaGEtd2ViaG9vay1zZWNyZXQ=");
    assert.equal(stray.status, 200);
    assert.deepEqual(await stray.json(), { ignored: "no_tenant" });

    // None of that reached a box.
    for (const gw of [c.gwA, c.gwB, c.gwOperator]) assert.equal(gw.calls.length, 0);
  } finally { await c.stop(); }
});

// ---- SETTINGS-2: who gets the operator section, and the relay is what decides -------------------
//
// The console draws an OPERATOR section holding endpoints, the job bus, the mail plane and the two
// box buttons. Getting this field wrong is not a cosmetic bug: it is one customer reading another
// customer's plumbing. So the rule is the relay's own tenantOf and the page never infers it, and
// this is the test that says so on a console really serving two customers and an operator.

test("a customer's session is not the operator's, and the console is told so rather than guessing", async () => {
  const c = await startConsole();
  try {
    const read = async (cookie) => {
      const answer = await fetch(`${c.relay.base}/auth/state`, { headers: cookie == null ? {} : { cookie } });
      assert.equal(answer.status, 200);
      return await answer.json();
    };

    // A stranger, above the gate. It answers what it always answered and nothing more: this route
    // sits in the pre-login band and a field about who you are must not be answered to nobody.
    const stranger = await read(null);
    assert.deepEqual(stranger, { required: true, authenticated: false });

    // Two customers. Neither is the operator, each is told its own workspace, and each carries its
    // own address off the sign-in link's verified claims.
    for (const slug of ["alpha", "beta"]) {
      const state = await read(await signInAsTenant(c.relay, slug));
      assert.equal(state.authenticated, true, slug);
      assert.equal(state.operator, false, `${slug} was handed the operator section`);
      assert.deepEqual(state.workspace, { slug, name: slug }, slug);
      assert.deepEqual(state.person, { email: `${slug}@titanium.bot` }, slug);
    }

    // The instance password IS the operator's door: it is the machine's own door and names no
    // person, which is why `person` is null rather than an address it would have to invent.
    const operator = await read(await signInAsOperator(c.relay));
    assert.equal(operator.operator, true);
    assert.equal(operator.person, null, "the instance-password door names nobody");
    assert.equal(typeof operator.workspace?.slug, "string");

    // And nothing about any of that touched a box.
    for (const gw of [c.gwA, c.gwB, c.gwOperator]) assert.equal(gw.calls.length, 0);
  } finally { await c.stop(); }
});

// Imported for the shape assertions above; naming them keeps the reader and the linter agreed.
assert.equal(typeof newAuthRecord, "function");
assert.equal(typeof writeAuthFile, "function");
