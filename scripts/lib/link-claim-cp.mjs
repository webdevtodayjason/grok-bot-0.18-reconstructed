// ONBOARD-5. The one control plane answer a gate needs when it signs a customer in by link.
//
// WHY THIS FILE EXISTS. A /login?sso= click used to be decided by the signature alone: the relay
// verified the token against that workspace's derived key and asked nobody anything. Since 2026-09-12
// it asks the control plane whether that link's id is still good, and a relay that cannot ask REFUSES
// the click rather than falling open -- so a gate that starts a relay copy with
// `CP_URL: "http://127.0.0.1:1"` and then clicks a hand-minted link now measures a 503 and nothing
// else. Two gate legs did exactly that (the box legs of verify-proxy), and a third copy of this stub in
// each of them is how two of the three drift.
//
// WHAT IT IS NOT. It is not the control plane. It holds no store, writes nothing and knows no
// workspaces. It answers one route, the way cp/server.mjs does, and it SPENDS a link the way
// cp/store.mjs claimSignInLink does: an id it has not seen is good and is then remembered, a second
// claim on the same id answers `used`. So a gate that clicks one link twice sees the real refusal
// rather than a flag somebody set.
//
// The credential is checked, for the same reason the real route checks it: a relay that forgot the
// header would pass every gate using this and refuse every link in production.
import { createServer } from "node:http";

export const CLAIM_ROUTE = "/v1/relay/sign-in-links/claim";

/**
 * Starts it on a loopback port. Answers `{base, claims, revoke, force, stop}`.
 *
 * `base` goes into the relay's CP_URL. `claims` is every question it was asked, in order, so a gate can
 * assert that the door asked once per click and named the id off the verified token.
 */
export async function startLinkClaimCp({ relayToken, verdict = null } = {}) {
  const expected = String(relayToken ?? "");
  const claims = [];
  const spent = new Set();
  const revoked = new Set();
  let forced = verdict;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const say = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const url = new URL(request.url, "http://cp.invalid");
      if (url.pathname !== CLAIM_ROUTE || request.method !== "POST") return say(404, { error: "not_found" });
      if (String(request.headers.authorization ?? "") !== `Bearer ${expected}`) {
        return say(401, { error: "unauthorized" });
      }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      const id = String(body?.id ?? "");
      claims.push({ id, tenant: String(body?.tenant ?? ""), from: String(body?.from ?? "") });
      if (id.length === 0) return say(400, { ok: false, error: "bad_request" });
      const answer = forced ?? (revoked.has(id) ? "revoked" : spent.has(id) ? "used" : "good");
      if (answer === "good") spent.add(id);
      return say(200, answer === "good"
        ? { ok: true, verdict: "good", tenant: String(body?.tenant ?? ""), singleUse: true }
        : { ok: false, verdict: answer });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    claims,
    revoke: (id) => revoked.add(String(id)),
    force: (value) => { forced = value; },
    // closeAllConnections first: the relay keeps the claim call's socket alive, and close() alone waits
    // for it, which is a gate that reports PASS and then never exits.
    stop: () => { try { server.closeAllConnections(); } catch {} server.close(); },
  };
}
