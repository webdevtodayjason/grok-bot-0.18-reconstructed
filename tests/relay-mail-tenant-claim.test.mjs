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
import { RELAY_TOKEN, signInAsTenant, startRelay, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";

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
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1",
    CP_RELAY_TOKEN: RELAY_TOKEN,
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
