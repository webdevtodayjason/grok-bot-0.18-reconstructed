// ui/tenant-login.mjs -- signing in to the console with a Titanium Bot account.
//
// A relay has always had exactly one door: the instance password, read once at boot out of
// auth.json. That is the right door for Jason, who owns the machine, and the wrong one for a
// customer, who should sign in as themselves and should not be handed a shared password over email.
//
// So the console has a second door. The customer types their account address and password on the
// same form; the relay hands both to the control plane and gets back a signed token; the relay
// checks the signature with that customer's own key and mints its own ordinary session cookie,
// carrying the tenant the token named. What the customer ends up holding is the same cookie the
// password would have minted, with one extra claim in it.
//
// TENANT-5 changed the shape around this and not the rules. There is now ONE relay, ONE console and
// ONE login page for everybody, so this file no longer belongs to a single tenant: it is handed a
// lookup, keyOf(slug), and it verifies each token with the key of the tenant that token claims.
// The redirect to <slug>.titanium.bot is gone with the per-tenant hostnames it pointed at.
//
// Three rules that shape everything below.
//
// 1. The relay verifies. It does not take the control plane's word for it and it does not call back
//    to ask. A token is signed with that tenant's own derived key (ui/session-token.mjs,
//    tenantSessionSecret), so a token minted for another customer does not check out under this
//    customer's key even though the same control plane signed both.
//
// 2. The tenant claim picks the key, it is never believed on its own. A liar names a tenant whose
//    key did not sign their token, so the signature check that follows fails. Naming a tenant this
//    console does not serve is not a redirect any more and not a refusal either: it is the plain
//    "that workspace is not available right now", the same sentence a session for a workspace still
//    provisioning gets.
//
// 3. The control plane is allowed to be down. It is one service on one machine and the instance
//    password is what the operator has when it is not answering, so an unreachable control plane
//    says so in plain words and never locks anyone out over it.
//
// Nothing here imports anything outside node builtins and ui/session-token.mjs, because the relay
// image has no node_modules at all.
import { tenantOfUnverifiedToken, verifySessionToken } from "./session-token.mjs";

// Long enough for a scrypt derivation on a busy control plane (the control plane's own gate lets
// four run at once and queues the rest), short enough that a hung service does not hold a browser
// on a blank page for a minute. The person can always fall back to the instance password.
export const CP_TIMEOUT_MS = 15_000;

// A control plane message is shown to the person signing in, so it is capped and it is escaped by
// the caller. Anything longer than this is not a sentence for a customer.
const CP_MESSAGE_LIMIT = 200;

// ---- is there a control plane behind this console ---------------------------------------------
//
// Both or neither. One of the two is a half-configured deploy, and the failure mode of guessing is
// the worst one available: a login page that offers an account sign-in which can never work, or a
// registry that is asked for with no credential and answers 401 every minute forever.
//
// TENANT_ID and CP_SESSION_SECRET are gone. They were per-instance values, and there is no longer
// such a thing as a per-instance relay: this console serves every tenant, and each tenant's derived
// key arrives in the registry route alongside its gateway token. The master key still never leaves
// the control plane, which is the property those two variables existed to protect.
export function relayConfig(env = process.env) {
  const cpUrl = String(env?.CP_URL ?? "").trim().replace(/\/+$/, "");
  const relayToken = String(env?.CP_RELAY_TOKEN ?? "").trim();
  if (cpUrl.length === 0 || relayToken.length === 0) return null;
  return { cpUrl, relayToken };
}

// ---- the sign-in ------------------------------------------------------------------------------
//
// Answers a verdict rather than a response, so the routing and the copy stay in server.mjs and this
// stays testable without a socket. The kinds:
//
//   session     verified with the claimed tenant's own key. payload is the token's claims.
//   unknown     a working sign-in for a workspace this console does not serve. slug names it.
//   refused     the control plane said no, or a token that does not verify.
//   busy        the control plane is rate limiting this address.
//   message     the control plane had something specific to say; text is its own words.
//   unreachable no answer, a timeout, or an answer that made no sense.
//
// keyOf(slug) returns that tenant's derived session key, or "" for a tenant we do not serve. It is
// the registry's sessionKeyOf in production and a plain object lookup in the tests.
//
// fetchImpl is injectable for the tests: a fake control plane in the same process, with no port and
// no timing. Production passes nothing and gets the global fetch.
export async function accountSignIn({
  config, email, password, client = "", keyOf = () => "", fetchImpl = fetch, now = Date.now(),
} = {}) {
  if (config == null) return { kind: "unreachable", detail: "this console has no control plane" };
  let response;
  try {
    response = await fetchImpl(`${config.cpUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Who is actually signing in, so the control plane's own lockout can count a person rather
        // than this container. Without it every customer shares one bucket there, because every
        // sign-in in the fleet arrives from one machine's egress address.
        //
        // It is only believed where the control plane already trusts this peer to speak for a
        // caller (CP_TRUSTED_PROXIES), which is the relay reaching it on a docker network. On the
        // public path the request goes through Cloudflare and Traefik, and Traefik REWRITES this
        // header from the connection it accepted, so the value below does not survive: there,
        // CP_RELAY_PEERS is what stops one bucket from being the whole fleet.
        ...(String(client ?? "").length > 0 ? { "x-forwarded-for": String(client) } : {}),
      },
      // The password is in this body and nowhere else. It is not logged here, it is not put in a
      // URL, and it is not kept after this call returns.
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(CP_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    return { kind: "unreachable", detail: error?.name === "TimeoutError" ? "timed out" : "no answer" };
  }

  if (response.status === 401) return { kind: "refused" };
  if (response.status === 429) return { kind: "busy" };

  let body = null;
  try { body = await response.json(); } catch { body = null; }

  if (response.status !== 200) {
    // The control plane writes its own plain words for the cases it knows about, and the one that
    // matters here is an account whose instance is not registered yet. Passing that through beats
    // telling a customer their sign-in is "not answering" when it answered perfectly clearly.
    const said = typeof body?.message === "string" ? body.message.trim() : "";
    if (said.length > 0 && said.length <= CP_MESSAGE_LIMIT) return { kind: "message", text: said };
    return { kind: "unreachable", detail: `HTTP ${response.status}` };
  }

  const token = typeof body?.token === "string" ? body.token : "";
  if (token.length === 0) return { kind: "unreachable", detail: "the answer carried no token" };

  return verdictForToken({ token, keyOf, now });
}

// The half both doors share: read the tenant a token claims, pick that tenant's key, verify. The
// claim chooses the key and nothing else, which is why reading it unverified is safe here.
function verdictForToken({ token, keyOf, now }) {
  const claimed = tenantOfUnverifiedToken(token);
  if (claimed.length === 0) return { kind: "refused", detail: "the token names no workspace" };

  let secret = "";
  try { secret = String(keyOf(claimed) ?? ""); } catch { secret = ""; }
  // A real account on a workspace this console cannot serve right now: still provisioning, or the
  // control plane has not been read since it was created. Not a refusal, because their password was
  // right, and not a redirect, because there is nowhere else to send them any more.
  if (secret.length === 0) return { kind: "unknown", slug: claimed };

  const verdict = verifySessionToken(token, secret, now);
  // A token that claims a tenant and does not verify under that tenant's key is not a working
  // sign-in, and there is nothing useful to say about which of the three reasons it was. It reads
  // as a refusal, which is also what it looks like from the customer's side: they are not getting in.
  if (!verdict.ok) return { kind: "refused", detail: verdict.reason };
  return { kind: "session", payload: verdict.payload };
}

// ---- arriving on a sign-in link ---------------------------------------------------------------
//
// /login?sso=<token>: the control plane minted a token and handed the browser a link to it. It is
// checked here the same way an account sign-in is, with the claimed tenant's own key, and nothing
// about the link is trusted including that it came from us.
export function ssoVerdict({ token, keyOf = () => "", now = Date.now() } = {}) {
  const raw = String(token ?? "");
  if (raw.length === 0) return { kind: "bad", detail: "empty" };
  const verdict = verdictForToken({ token: raw, keyOf, now });
  if (verdict.kind === "session") {
    // Belt and braces: the signature already proves the tenant, because the key is derived from the
    // tenant name and no other tenant's key produces this signature. The claim is checked against
    // the payload anyway so that a mistake in how a key was configured -- a master pasted where a
    // derived key belongs, which is the one way this could go wrong -- fails closed.
    if (verdict.payload.tenant !== tenantOfUnverifiedToken(raw)) return { kind: "bad", detail: "another tenant" };
    return verdict;
  }
  if (verdict.kind === "unknown") return { kind: "unknown", slug: verdict.slug };
  return { kind: "bad", detail: verdict.detail ?? "not valid" };
}
