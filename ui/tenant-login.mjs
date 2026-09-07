// ui/tenant-login.mjs -- signing in to a tenant relay with a Titanium Bot account.
//
// A relay has always had exactly one door: the instance password, read once at boot out of
// auth.json. That is the right door for Jason, who owns the box, and the wrong one for a customer,
// who should sign in as themselves and should not be handed a shared password over email.
//
// So a tenant relay gets a second door. The customer types their account address and password on
// the same form; the relay hands both to the control plane and gets back a signed token; the relay
// checks the signature with the key it was given and mints its own ordinary session cookie. What
// the customer ends up holding is the same cookie the password would have minted. Nothing about the
// rest of the console changes, and the token itself is never stored.
//
// Three rules that shape everything below.
//
// 1. The relay verifies. It does not take the control plane's word for it and it does not call
//    back to ask. The token is signed with CP_SESSION_SECRET, which is this tenant's own derived
//    key (ui/session-token.mjs, tenantSessionSecret), so a token minted for another customer does
//    not check out here even though the same control plane signed it.
//
// 2. The tenant claim is checked, not assumed. A person with an account on another instance can
//    type their address into this login by mistake or on purpose. The control plane answers with a
//    token for THEIR instance, this relay sees a tenant that is not its own, and it sends them to
//    their own host instead of refusing. That redirect carries the token in the query string, which
//    is the only way a browser can carry it across two origins, and the receiving relay verifies it
//    with its own key before it does anything at all.
//
// 3. The control plane is allowed to be down. It is one service on one machine and the instance
//    password is what the operator has when it is not answering, so an unreachable control plane
//    says so in plain words and never locks anyone out over it.
//
// Nothing here imports anything outside node builtins and ui/session-token.mjs, because the relay
// image has no node_modules at all.
import { base64urlDecode, tenantOfUnverifiedToken, verifySessionToken } from "./session-token.mjs";

// Long enough for a scrypt derivation on a busy control plane (the control plane's own gate lets
// four run at once and queues the rest), short enough that a hung service does not hold a browser
// on a blank page for a minute. The person can always fall back to the instance password.
export const CP_TIMEOUT_MS = 15_000;

// A control plane message is shown to the person signing in, so it is capped and it is escaped by
// the caller. Anything longer than this is not a sentence for a customer.
const CP_MESSAGE_LIMIT = 200;

// ---- is this a tenant relay ---------------------------------------------------------------
//
// All three or none. Two of the three is a half-configured deploy, and the failure mode of guessing
// is the worst one available: a login page that offers an account sign-in which can never work, or
// worse, a verify against an empty secret. The control plane renders all three into a tenant's
// compose together, so anything else is a hand edit and is treated as "not a tenant".
export function tenantConfig(env = process.env) {
  const tenant = String(env?.TENANT_ID ?? "").trim();
  const cpUrl = String(env?.CP_URL ?? "").trim().replace(/\/+$/, "");
  const secret = String(env?.CP_SESSION_SECRET ?? "").trim();
  if (tenant.length === 0 || cpUrl.length === 0 || secret.length === 0) return null;
  return { tenant, cpUrl, secret };
}

// ---- reading a token we cannot verify -------------------------------------------------------
//
// Only ever for the redirect in rule 2, and only the host. It is unverified by construction: the
// token is signed with the other tenant's key and this relay does not have it and must not have it.
// What makes that safe is that nothing is granted here -- the person is sent to another origin,
// which verifies properly before it mints anything -- and that the value goes into a Location
// header, so it is checked against what a hostname is allowed to look like first.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function hostOfUnverifiedToken(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return "";
  let payload;
  try { payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8")); }
  catch { return ""; }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
  const host = String(payload.host ?? "").trim();
  // A hostname, nothing else. No scheme, no port, no path, no credentials, no CR or LF: every one
  // of those turns a redirect into either an open redirect or a header injection, and none of them
  // is something a real host claim contains.
  if (host.length === 0 || host.length > 253) return "";
  return HOSTNAME.test(host) ? host.toLowerCase() : "";
}

// ---- the sign-in ------------------------------------------------------------------------------
//
// Answers a verdict rather than a response, so the routing and the copy stay in server.mjs and this
// stays testable without a socket. The kinds:
//
//   session     this tenant's own, verified with our key. payload is the token's claims.
//   elsewhere   a valid sign-in for another instance. location is where to send the browser.
//   refused     the control plane said no, or a token for us that does not verify.
//   busy        the control plane is rate limiting this address.
//   message     the control plane had something specific to say; text is its own words.
//   unreachable no answer, a timeout, or an answer that made no sense.
//
// fetchImpl is injectable for the tests: a fake control plane in the same process, with no port and
// no timing. Production passes nothing and gets the global fetch.
export async function accountSignIn({ config, email, password, client = "", fetchImpl = fetch, now = Date.now() } = {}) {
  if (config == null) return { kind: "unreachable", detail: "this relay is not in tenant mode" };
  let response;
  try {
    response = await fetchImpl(`${config.cpUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Who is actually signing in, so the control plane's own lockout can count a person rather
        // than this container. Without it every customer on every instance shares one bucket there,
        // because every sign-in in the fleet arrives from one machine's egress address.
        //
        // It is only believed where the control plane already trusts this peer to speak for a
        // caller (CP_TRUSTED_PROXIES), which is a relay reaching it on a docker network. On the
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

  const claimed = tenantOfUnverifiedToken(token);
  if (claimed !== config.tenant) {
    const host = hostOfUnverifiedToken(token);
    if (host.length === 0) return { kind: "unreachable", detail: "the token names no host we can send anyone to" };
    return { kind: "elsewhere", host, location: `https://${host}/login?sso=${encodeURIComponent(token)}` };
  }

  const verdict = verifySessionToken(token, config.secret, now);
  // A token that claims to be ours and does not verify is not a working sign-in and there is
  // nothing useful to say about which of the three reasons it was. It reads as a refusal, which is
  // also what it looks like from the customer's side: they are not getting in.
  if (!verdict.ok) return { kind: "refused", detail: verdict.reason };
  return { kind: "session", payload: verdict.payload };
}

// ---- arriving on a sign-in link ---------------------------------------------------------------
//
// The other half of rule 2. Somebody signed in at another instance's login, the control plane said
// the account belongs here, and that relay sent them over with the token in the query string. This
// is where it is actually checked: our key, our tenant, and not expired. Everything else is a bad
// link and says so.
export function ssoVerdict({ config, token, now = Date.now() } = {}) {
  if (config == null) return { kind: "bad", detail: "this relay is not in tenant mode" };
  const raw = String(token ?? "");
  if (raw.length === 0) return { kind: "bad", detail: "empty" };
  const verdict = verifySessionToken(raw, config.secret, now);
  if (!verdict.ok) return { kind: "bad", detail: verdict.reason };
  // Belt and braces: the signature already proves the tenant, because the key is derived from the
  // tenant name and no other tenant's key produces this signature. The claim is checked anyway so
  // that a mistake in how the secret was configured -- a master key pasted where a derived key
  // belongs, which is the one way this could go wrong -- fails closed instead of letting a token
  // for any tenant at all in.
  if (verdict.payload.tenant !== config.tenant) return { kind: "bad", detail: "another tenant" };
  return { kind: "session", payload: verdict.payload };
}
