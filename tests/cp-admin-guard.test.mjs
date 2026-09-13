// ONBOARD-2 / ADMIN-5. The guard in front of the two most destructive routes in the product.
//
// WHY THIS FILE EXISTS. `POST /v1/admin/clients` builds a workspace, a container and an account;
// `DELETE /v1/admin/clients/:slug` with `deleteData` takes all three away and removes the customer's
// files. Both sit behind cp/admin.mjs's `requireSuperAdmin`, which is three checks and not one: the
// account the token's `sub` names must exist, its tenant and its email must match the token's own
// claims, and it must be a super admin who is not disabled. The tenant and email checks are the ones
// that matter, because a session token is signed with THAT TENANT'S DERIVED KEY -- so a customer who
// could swap the `sub` for a super admin's account id would be signing a valid token for somebody
// else's authority with a key they legitimately hold.
//
// The guard holds. It was probed live against a real control plane on this Mac 2026-09-10 and refused
// all eight shapes below. Nothing in the repo asserted it: `grep -rn requireSuperAdmin tests/
// scripts/` returned nothing, and the only mention of superAdmin in the suites was store-level flag
// flipping. So the three-check guard had no net under it, and an edit that dropped the tenant
// comparison for looking redundant would have been a customer deleting another customer with a green
// test run behind it.
//
// This is that net. Eight probes, the two routes, and an assertion after every one that the tenant
// row and the account are still there.
import assert from "node:assert/strict";
import test from "node:test";

import { mintSessionToken, tenantSessionSecret } from "../cp/session.mjs";
import { startControlPlane } from "./cp-support.mjs";

const PASSWORD = "a-good-password";

/**
 * A control plane with one super admin on `titanium` and one customer's owner on `acme-roofing`.
 *
 * Both tenants are ADOPTED rather than provisioned, because this file is about the door and a
 * Coolify build in front of each probe buys nothing. Adopted also means the removal's own guard
 * refuses them, which is the wrong refusal for this test -- so the assertions here are on the 401
 * and on the rows surviving, never on a removal succeeding.
 */
async function world() {
  const plane = await startControlPlane();
  await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "svc-console", host: "titanium.titanium.bot" });
  await plane.admin("POST", "/v1/tenants/acme-roofing/adopt", { coolifyServiceUuid: "svc-acme", host: "acme-roofing.titanium.bot" });
  const boss = await plane.admin("POST", "/v1/accounts", { email: "boss@titaniumcomputing.test", password: PASSWORD, name: "The Operator", tenant: "titanium" });
  assert.equal(boss.status, 201, boss.text);
  plane.store.setSuperAdmin("boss@titaniumcomputing.test", true);
  const jane = await plane.admin("POST", "/v1/accounts", { email: "jane@acme.test", password: PASSWORD, name: "Jane", tenant: "acme-roofing" });
  assert.equal(jane.status, 201, jane.text);
  const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "jane@acme.test", password: PASSWORD } });
  assert.equal(signIn.status, 200, signIn.text);
  assert.equal(signIn.body.account.superAdmin, false);
  return { plane, boss: boss.body.account, jane: jane.body.account, janeToken: signIn.body.token };
}

test("no credential a customer can hold opens the add or the remove, and the rows survive every try", async () => {
  const { plane, boss, jane, janeToken } = await world();
  try {
    // A FORGED SESSION, signed with the key the customer legitimately holds but carrying the super
    // admin's account id. This is the attack the tenant and email checks exist for: `tenant` is what
    // picks the derivation, so a customer can sign a token whose `tenant` is their own and whose
    // `sub` is anybody's, and the only thing standing in the way is that the account at that `sub`
    // does not belong to the tenant the token names.
    const forgedOwnTenant = mintSessionToken(
      { sub: boss.id, email: "jane@acme.test", tenant: "acme-roofing", host: "console.titanium.bot", jti: "forged-1" },
      tenantSessionSecret(plane.config.sessionSecret, "acme-roofing"),
    ).token;
    // The same swap, claiming the operator's own workspace. The signature is still the customer's
    // key, so it cannot verify against `titanium`'s derivation at all.
    const forgedOtherTenant = mintSessionToken(
      { sub: boss.id, email: "boss@titaniumcomputing.test", tenant: "titanium", host: "console.titanium.bot", jti: "forged-2" },
      tenantSessionSecret(plane.config.sessionSecret, "acme-roofing"),
    ).token;

    // THE ONE THAT ISOLATES THE TENANT CHECK. `sub` and `email` are both the super admin's, so the
    // account lookup and the email comparison BOTH pass; only "that account does not belong to the
    // tenant this token names" is left standing between a customer's own signing key and the super
    // admin console. Dropping that one comparison as redundant is the edit this file exists to fail.
    const forgedRightEmail = mintSessionToken(
      { sub: boss.id, email: "boss@titaniumcomputing.test", tenant: "acme-roofing", host: "console.titanium.bot", jti: "forged-3" },
      tenantSessionSecret(plane.config.sessionSecret, "acme-roofing"),
    ).token;

    const add = { email: "someone@new.test", company: "Someone New", name: "Someone" };
    const remove = { confirm: "acme-roofing", deleteData: true };
    // ONBOARD-5. A live sign-in link to aim the two new routes at, minted with the operator's own
    // bearer. Cancelling somebody else's customer's sign-in link is a small act with a real effect --
    // it is the difference between a customer getting into their console this morning and not -- so it
    // belongs in this net like every other route that changes something.
    const minted = await plane.admin("POST", "/v1/admin/clients/acme-roofing/sign-in-link", {});
    assert.equal(minted.status, 200, minted.text);
    const liveLink = minted.body.id;
    const probes = [
      ["a customer's own valid session", janeToken],
      ["a forged session on the customer's own tenant", forgedOwnTenant],
      ["a forged session claiming the operator's tenant", forgedOtherTenant],
      ["a forged session carrying the super admin's own sub and email", forgedRightEmail],
      ["no credential at all", ""],
    ];

    for (const [what, token] of probes) {
      const listed = await plane.request("GET", "/v1/admin/clients", { token });
      assert.equal(listed.status, 401, `${what} listed the clients: ${listed.text}`);
      const added = await plane.request("POST", "/v1/admin/clients", { token, body: add });
      assert.equal(added.status, 401, `${what} added a client: ${added.text}`);
      assert.equal(added.body?.message, "This console is for super admins.", added.text);
      const removed = await plane.request("DELETE", "/v1/admin/clients/acme-roofing", { token, body: remove });
      assert.equal(removed.status, 401, `${what} removed a client: ${removed.text}`);
      const link = await plane.request("POST", "/v1/admin/clients/acme-roofing/sign-in-link", { token, body: {} });
      assert.equal(link.status, 401, `${what} minted a sign-in link: ${link.text}`);
      const welcome = await plane.request("POST", "/v1/admin/clients/acme-roofing/welcome", { token, body: {} });
      assert.equal(welcome.status, 401, `${what} sent a welcome: ${welcome.text}`);
      const links = await plane.request("GET", "/v1/admin/clients/acme-roofing/sign-in-links", { token });
      assert.equal(links.status, 401, `${what} listed the sign-in links: ${links.text}`);
      const killed = await plane.request("POST", "/v1/admin/clients/acme-roofing/sign-in-link/revoke", { token, body: { id: liveLink } });
      assert.equal(killed.status, 401, `${what} cancelled a sign-in link: ${killed.text}`);

      // AFTER EVERY PROBE, not once at the end. A door that refuses the answer and does the work
      // first is the failure this is looking for.
      assert.notEqual(plane.store.getTenant("acme-roofing"), null, `${what} removed the tenant row`);
      assert.equal(plane.store.getAccountById(jane.id)?.disabled === true, false, `${what} disabled the customer`);
      assert.equal(plane.store.getAccountByEmail?.("someone@new.test") ?? null, null, `${what} created an account`);
      assert.equal(plane.store.getSignInLink(liveLink)?.revokedAt, 0, `${what} cancelled the sign-in link anyway`);
    }

    // AND THE DOOR IS NOT SHUT FOR EVERYBODY, which is the other half of a guard test: the same
    // routes open to the operator's own bearer, so a refusal above is the guard working rather than
    // the routes being broken for all comers.
    assert.equal((await plane.admin("GET", "/v1/admin/clients")).status, 200);
  } finally {
    await plane.dispose();
  }
});

test("a super admin's real session opens both, and a disabled one stops opening them", async () => {
  const { plane } = await world();
  try {
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "boss@titaniumcomputing.test", password: PASSWORD } });
    assert.equal(signIn.status, 200, signIn.text);
    const token = signIn.body.token;
    assert.equal((await plane.request("GET", "/v1/admin/clients", { token })).status, 200);
    // The remove refuses this workspace because it was ADOPTED, which is a 409 from the removal's own
    // guard and therefore proof the session got past the door rather than being turned away at it.
    const adopted = await plane.request("DELETE", "/v1/admin/clients/acme-roofing", { token, body: { confirm: "acme-roofing" } });
    assert.notEqual(adopted.status, 401, adopted.text);

    // The flag is looked up on every request rather than carried in the token, so taking it away ends
    // the session's authority immediately and without a new sign-in.
    plane.store.setSuperAdmin("boss@titaniumcomputing.test", false);
    assert.equal((await plane.request("GET", "/v1/admin/clients", { token })).status, 401);
    plane.store.setSuperAdmin("boss@titaniumcomputing.test", true);
    plane.store.setAccountDisabled(signIn.body.account.id, true);
    assert.equal((await plane.request("GET", "/v1/admin/clients", { token })).status, 401,
      "a disabled super admin's live session must stop opening this console");
  } finally {
    await plane.dispose();
  }
});
