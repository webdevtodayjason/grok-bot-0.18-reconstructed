// A mail domain is one workspace's, and a claim to it has to check out.
//
// The webhook carries no session and no bearer, so the tenant has to be chosen from the recipient's
// DOMAIN before anything is verified, and mail.json's domain is a free string any signed-in
// customer types into their own console. The first version of the loop returned on the first
// workspace claiming the domain, and tenants sort before the operator, so a customer who typed
// somebody else's domain into their own card won the loop and the mail was answered 401 and
// retried for hours while its owner never saw it.
//
// Two rules are measured here. A claim only nominates: when more than one workspace claims the
// domain, the one whose signing secret verifies THIS body gets the message. And the console says
// no at the moment the second claim is typed, rather than leaving it on disk to be settled every
// time a message arrives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { signSvix } from "../ui/mail-edge.mjs";
import {
  RELAY_TOKEN, signInAsTenant, startRelay, startRelayWithLinks, tenantRow, tenantsFile,
} from "./relay-tenant-support.mjs";

const OWNER_SECRET = `whsec_${Buffer.from("the owner's signing secret").toString("base64")}`;
const IMPOSTOR_SECRET = `whsec_${Buffer.from("a secret Resend never signed").toString("base64")}`;

const body = (to) => JSON.stringify({
  type: "email.received",
  data: { email_id: `em_${Math.random().toString(36).slice(2)}`, to: [to], from: "someone@example.com", subject: "hello" },
});

const post = (relay, raw, secret) => {
  const id = "msg_2test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${relay.base}/hooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id, "svix-timestamp": timestamp,
      "svix-signature": signSvix(secret, { id, timestamp }, raw),
    },
    body: raw,
  });
};

// Two workspaces, both claiming titanium.bot. "acme" sorts first in the registry file, which is the
// order the loop walks, so it is the one the old code handed the message to.
async function consoleWithTwoClaimants({ impostorSecret = IMPOSTOR_SECRET } = {}) {
  const impostor = tenantRow("acme");
  const owner = tenantRow("beta");
  writeFileSync(path.join(impostor.state, "mail.json"), JSON.stringify({
    enabled: true, domain: "titanium.bot", webhookSecret: impostorSecret,
  }));
  // enabled false on the real owner, so a message that reaches it is answered "disabled" without a
  // gateway call. That answer is only reachable past the signature check, which is the proof.
  writeFileSync(path.join(owner.state, "mail.json"), JSON.stringify({
    enabled: false, domain: "titanium.bot", webhookSecret: OWNER_SECRET,
  }));
  const relay = await startRelay({ SAND_UI_TENANTS_FILE: tenantsFile([impostor.row, owner.row]) }, { pathValue: "/nonexistent" });
  return { relay, impostor, owner };
}

test("a customer who types another workspace's mail domain does not take that workspace's mail", async () => {
  const { relay } = await consoleWithTwoClaimants();
  try {
    const raw = body("titan@titanium.bot");
    const res = await post(relay, raw, OWNER_SECRET);
    assert.equal(res.status, 200, "the workspace holding the signing secret answered");
    assert.deepEqual(await res.json(), { ignored: "disabled" },
      "the message reached the owner's edge, past its signature check");
  } finally { relay.stop(); }
});

test("two claimants and no secret that verifies is a decision, not a retry", async () => {
  const { relay } = await consoleWithTwoClaimants();
  try {
    const raw = body("titan@titanium.bot");
    const res = await post(relay, raw, `whsec_${Buffer.from("neither of theirs").toString("base64")}`);
    assert.equal(res.status, 200, "200 so Resend stops rather than retrying a decision that will not change");
    assert.deepEqual(await res.json(), { ignored: "no_verified_tenant" });
  } finally { relay.stop(); }
});

test("one claimant with the wrong secret still gets the plain 401 its own edge writes", async () => {
  const only = tenantRow("acme");
  writeFileSync(path.join(only.state, "mail.json"), JSON.stringify({
    enabled: true, domain: "titanium.bot", webhookSecret: IMPOSTOR_SECRET,
  }));
  const other = tenantRow("beta");
  const relay = await startRelay({ SAND_UI_TENANTS_FILE: tenantsFile([only.row, other.row]) }, { pathValue: "/nonexistent" });
  try {
    const raw = body("titan@titanium.bot");
    const res = await post(relay, raw, OWNER_SECRET);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "invalid_signature" });
  } finally { relay.stop(); }
});

test("the console refuses a mail domain another workspace on it already holds", async () => {
  const held = tenantRow("acme");
  const other = tenantRow("beta");
  writeFileSync(path.join(held.state, "mail.json"), JSON.stringify({
    enabled: true, domain: "titanium.bot", webhookSecret: OWNER_SECRET,
  }));
  // startRelayWithLinks and not startRelay: signInAsTenant below is a sign-in link, and since
  // ONBOARD-5 a link is checked with the control plane on every click.
  const relay = await startRelayWithLinks({
    SAND_UI_TENANTS_FILE: tenantsFile([held.row, other.row]),
  }, { pathValue: "/nonexistent" });
  try {
    const cookie = await signInAsTenant(relay, "beta");
    const res = await fetch(`${relay.base}/mail/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ domain: "titanium.bot" }),
    });
    assert.equal(res.status, 409);
    const answer = await res.json();
    assert.match(String(answer.error ?? ""), /already the mail domain/);
    // And a domain nobody holds still saves.
    const ok = await fetch(`${relay.base}/mail/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ domain: "beta.example" }),
    });
    assert.equal(ok.status, 200);
  } finally { relay.stop(); }
});

// ---------------------------------------------------------------- the directory is not a claim
//
// MAIL-2 shipped a second, worse version of the same bug. The per-bot addresses live in ONE
// directory that spans every workspace, but the credential that unlocks the route to it is the
// signing secret each customer types into their own Mail card. So a customer could set their own
// domain to the directory's, sign a body with their own secret naming another customer's
// agent<code>@ address, and the relay would hand their words to that customer's bot: reproduced
// end to end against the shipped tree, HTTP 200 and a delivery into a workspace the poster has no
// account on.
//
// Two rules close it, and both are measured below. The door sends a recipient at the directory's
// domain to the workspace that holds that domain and to nobody else, whatever anybody's mail.json
// claims. And an edge that is not that workspace refuses to resolve a code at all, so a wrong
// setting on the door is still not a delivery.
const DIRECTORY_DOMAIN = "myagents.email";
const VICTIM_CODE = "agent123456";

function consoleWithADirectory({ ownerSecret = OWNER_SECRET } = {}) {
  const impostor = tenantRow("acme");
  const owner = tenantRow("gamma");
  const victim = tenantRow("beta");
  // The impostor types the directory's own domain into their own card and sets their own secret,
  // which is exactly what a customer with a console login can do.
  writeFileSync(path.join(impostor.state, "mail.json"), JSON.stringify({
    enabled: true, domain: DIRECTORY_DOMAIN, webhookSecret: IMPOSTOR_SECRET,
  }));
  // enabled false on the workspace that really holds it, so a message that gets past the signature
  // check answers "disabled" and nothing is asked of a box. That answer is the proof of arrival.
  writeFileSync(path.join(owner.state, "mail.json"), JSON.stringify({
    enabled: false, domain: DIRECTORY_DOMAIN, webhookSecret: ownerSecret,
  }));
  const directory = path.join(victim.state, "directory.json");
  writeFileSync(directory, JSON.stringify({
    domain: DIRECTORY_DOMAIN,
    measuredAt: new Date().toISOString(),
    tenants: {
      beta: {
        approvedSendersOnly: false, senders: [],
        addresses: [{
          agentId: "beta-titan", code: "123456", agentName: "Titan",
          address: `${VICTIM_CODE}@${DIRECTORY_DOMAIN}`, state: "active",
        }],
      },
    },
  }));
  return { impostor, owner, victim, directory };
}

test("a workspace cannot sign mail into another workspace's bot at the directory's domain", async () => {
  const { impostor, owner, victim, directory } = consoleWithADirectory();
  const relay = await startRelay({
    SAND_UI_TENANTS_FILE: tenantsFile([impostor.row, owner.row, victim.row]),
    SAND_UI_MAIL_DIRECTORY_FILE: directory,
    // Which workspace's Resend account holds myagents.email. On the R750 it is the operator's and
    // this is not set; here it is named so the test does not depend on which slug that is.
    CP_MAIL_OWNER_SLUG: "gamma",
  }, { pathValue: "/nonexistent" });
  try {
    const raw = body(`${VICTIM_CODE}@${DIRECTORY_DOMAIN}`);
    const res = await post(relay, raw, IMPOSTOR_SECRET);
    // The impostor's secret verifies nothing on the owner's edge, which is the only edge a
    // recipient at this domain reaches. Nothing was resolved and nothing was delivered.
    assert.equal(res.status, 401, "a body signed by a workspace that does not hold the domain is refused");
    assert.deepEqual(await res.json(), { error: "invalid_signature" });
  } finally { relay.stop(); }
});

test("the workspace that holds the directory's domain still gets its own mail", async () => {
  const { impostor, owner, victim, directory } = consoleWithADirectory();
  const relay = await startRelay({
    SAND_UI_TENANTS_FILE: tenantsFile([impostor.row, owner.row, victim.row]),
    SAND_UI_MAIL_DIRECTORY_FILE: directory,
    // Which workspace's Resend account holds myagents.email. On the R750 it is the operator's and
    // this is not set; here it is named so the test does not depend on which slug that is.
    CP_MAIL_OWNER_SLUG: "gamma",
  }, { pathValue: "/nonexistent" });
  try {
    const raw = body(`${VICTIM_CODE}@${DIRECTORY_DOMAIN}`);
    const res = await post(relay, raw, OWNER_SECRET);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: "disabled" },
      "it reached the directory owner's edge, past its signature check");
  } finally { relay.stop(); }
});
