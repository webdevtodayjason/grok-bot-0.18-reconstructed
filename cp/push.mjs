// The two push credentials: what they are, and how each one is PROVED before it is stored (PUSH-1).
//
// Its own file for the reason cp/feedback.mjs is its own file: every function here is a pure function
// over a pasted credential, none of them needs a store, a config or a request, and all of them have
// to be testable without standing a control plane up. cp/Dockerfile copies the cp/ DIRECTORY, so
// this file needs no line there.
//
// WHY PROVE AT ALL. A key that the vendor will not take is a Notifications switch in a customer's
// Settings that works for weeks and then does not wake anybody, on somebody else's morning. The
// provider keys on this service are already proved before they are stored; these are held to the
// same bar, and for the same reason.
//
// WHAT EACH PROOF ACTUALLY DISTINGUISHES, which is the whole design of it:
//
//   APNs   send to a deliberately MALFORMED device token and require 400 BadDeviceToken.
//          400 BadDeviceToken  Apple read our provider token, accepted it, and refused the address.
//                              That is the credential working. PASS.
//          403 InvalidProviderToken / MissingProviderToken / ExpiredProviderToken
//                              Apple refused the .p8, the key id, or the team id. REFUSE.
//          400 TopicDisallowed / BadTopic
//                              the bundle id does not belong to that key. REFUSE, and say which.
//
//   FCM    mint the OAuth token, then send with validate_only: true, which is a free dry run.
//          200                 everything is right. PASS.
//          400 INVALID_ARGUMENT on the deliberately malformed registration token
//                              Google read our service account, accepted it, and refused the
//                              address. That is the credential working. PASS.
//          401 / 403           the service account, its key, or the messaging scope is wrong.
//                              REFUSE.
//          404                 that project id does not exist for this service account. REFUSE.
//
// NOTHING HERE LOGS OR RETURNS A VALUE. Every answer is {ok, how, why} in plain words. The caller
// stores a length and eight hex characters of a digest and nothing else, ever.
import { createPrivateKey, createSign } from "node:crypto";

/** Apple's two hosts. The sandbox is used for the PROOF whichever env a device later registers on:
 *  a provider token is valid at both, so the cheaper host is the honest place to ask. */
export const APNS_PROOF_HOST = "api.sandbox.push.apple.com";
export const FCM_SEND_BASE = "https://fcm.googleapis.com/v1/projects";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A token Apple and Google both have to refuse on its shape alone, so the proof never reaches a
 *  real phone. 64 hex characters is the right LENGTH for APNs and this value is not a device. */
export const PROOF_DEVICE_TOKEN = "00".repeat(32);

const str = (value) => (typeof value === "string" ? value : "");
const trim = (value) => str(value).trim();

/** The Apple bits a .p8 arrives with. All four are required: a key with no team id opens nothing. */
export function parseApnsCredential(raw) {
  const key = str(raw?.key).replace(/\r\n/g, "\n").trim();
  const keyId = trim(raw?.keyId);
  const teamId = trim(raw?.teamId);
  const bundleId = trim(raw?.bundleId);
  if (!/^-----BEGIN PRIVATE KEY-----/.test(key)) {
    return { ok: false, why: "That is not a .p8 signing key. Paste the whole file, including the BEGIN PRIVATE KEY line." };
  }
  if (!/^[A-Z0-9]{10}$/.test(keyId)) return { ok: false, why: "A key id is ten characters of capitals and digits, from the key's filename." };
  if (!/^[A-Z0-9]{10}$/.test(teamId)) return { ok: false, why: "A team id is ten characters of capitals and digits, from the Apple developer account." };
  if (!/^[A-Za-z0-9.-]{3,155}$/.test(bundleId)) return { ok: false, why: "A bundle id looks like bot.titanium.app." };
  try { createPrivateKey(key); }
  catch { return { ok: false, why: "That key could not be read as a private key. Paste the file exactly as Apple gave it." }; }
  return { ok: true, key, keyId, teamId, bundleId };
}

/** The Firebase bits. The service account JSON arrives as pasted text; the project id may come from
 *  the JSON itself, which is the usual case, or be typed over it. */
export function parseFcmCredential(raw) {
  let account = raw?.serviceAccount;
  if (typeof account === "string") {
    try { account = JSON.parse(account); }
    catch { return { ok: false, why: "That was not the service account JSON. Paste the whole file Firebase downloaded." }; }
  }
  if (account == null || typeof account !== "object") {
    return { ok: false, why: "Paste the service account JSON Firebase downloaded." };
  }
  const clientEmail = trim(account.client_email);
  const privateKey = str(account.private_key).replace(/\\n/g, "\n");
  const projectId = trim(raw?.projectId) || trim(account.project_id);
  if (account.type !== "service_account") return { ok: false, why: 'That JSON is not a service account (its "type" should be service_account).' };
  if (!clientEmail.includes("@")) return { ok: false, why: "That service account has no client_email in it." };
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/m.test(privateKey)) return { ok: false, why: "That service account has no private_key in it." };
  if (projectId.length === 0) return { ok: false, why: "Name the Firebase project, or paste a service account that carries its project_id." };
  try { createPrivateKey(privateKey); }
  catch { return { ok: false, why: "That service account's private_key could not be read. Paste the file exactly as Firebase gave it." }; }
  return {
    ok: true,
    projectId,
    serviceAccount: { type: "service_account", project_id: projectId, client_email: clientEmail, private_key: privateKey, token_uri: trim(account.token_uri) || GOOGLE_TOKEN_URL },
  };
}

const base64url = (value) => Buffer.from(value).toString("base64url");

/** The provider token Apple wants: ES256 over {alg, kid} and {iss, iat}, and nothing else in it. */
export function apnsProviderToken({ key, keyId, teamId, nowMs = Date.now() }) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key: createPrivateKey(key), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

/** The Google assertion, for the one scope this service ever needs. */
export function fcmAssertion({ serviceAccount, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: serviceAccount.token_uri || GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(createPrivateKey(serviceAccount.private_key)).toString("base64url")}`;
}

/** What Apple's refusal word means for the paste. The table at the top of this file, as code. */
export function readApnsVerdict({ status, reason }) {
  const word = trim(reason);
  if (status === 400 && word === "BadDeviceToken") {
    return { ok: true, how: `${APNS_PROOF_HOST}, which read the key and refused only the address` };
  }
  if (status === 403 || word === "InvalidProviderToken" || word === "MissingProviderToken" || word === "ExpiredProviderToken") {
    return { ok: false, why: `Apple refused the signing key itself (${word || `HTTP ${status}`}). Check the .p8, the key id and the team id belong together.` };
  }
  if (word === "TopicDisallowed" || word === "BadTopic") {
    return { ok: false, why: "Apple took the key and refused the bundle id, so that key is not enabled for that app." };
  }
  if (status === 200) return { ok: true, how: `${APNS_PROOF_HOST} accepted it outright` };
  if (status === 0) return { ok: false, why: "Apple did not answer, so nothing could be checked and nothing was stored." };
  return { ok: false, why: `Apple answered HTTP ${status}${word ? ` ${word}` : ""}, which is not an answer this check knows how to read.` };
}

/** And Google's. */
export function readFcmVerdict({ status, code }) {
  const word = trim(code);
  if (status === 200) return { ok: true, how: "a validate_only dry run Firebase accepted" };
  if (status === 400 && (word === "INVALID_ARGUMENT" || word === "")) {
    return { ok: true, how: "a validate_only dry run Firebase read with the service account and refused only the address" };
  }
  if (status === 401 || status === 403) {
    return { ok: false, why: "Firebase refused the service account, so either the key is wrong or that account has no Cloud Messaging permission." };
  }
  if (status === 404) return { ok: false, why: "Firebase has no such project for that service account. Check the project id." };
  if (status === 0) return { ok: false, why: "Firebase did not answer, so nothing could be checked and nothing was stored." };
  return { ok: false, why: `Firebase answered HTTP ${status}${word ? ` ${word}` : ""}, which is not an answer this check knows how to read.` };
}

/**
 * Ask Apple. `http2` is injected so a test drives the verdict table without a network, which is how
 * every branch of readApnsVerdict above is reached without an Apple account.
 */
export async function proveApnsCredential({ key, keyId, teamId, bundleId, http2, host = APNS_PROOF_HOST, nowMs = Date.now(), timeoutMs = 10_000 }) {
  if (http2 == null) return { ok: false, why: "this service has no http2, so the key could not be checked" };
  let token;
  try { token = apnsProviderToken({ key, keyId, teamId, nowMs }); }
  catch { return { ok: false, why: "That key could not sign a provider token, so nothing was stored." }; }
  const answer = await new Promise((resolve) => {
    let settled = false;
    let session = null;
    // One request, then the connection goes: this runs once per paste, so a held session would be
    // state kept for nothing, and a leaked one would keep this service talking to Apple forever.
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { session?.close(); } catch { /* already gone */ }
      resolve(value);
    };
    try { session = http2.connect(`https://${host}`); }
    catch (error) { done({ status: 0, reason: String(error?.message ?? error) }); return; }
    session.on("error", (error) => done({ status: 0, reason: String(error?.message ?? error) }));
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${PROOF_DEVICE_TOKEN}`,
      "content-type": "application/json",
      authorization: `bearer ${token}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
    });
    let status = 0;
    let text = "";
    request.setTimeout(timeoutMs, () => { request.close(); done({ status: 0, reason: "timed out" }); });
    request.on("response", (headers) => { status = Number(headers[":status"]) || 0; });
    request.on("data", (chunk) => { if (text.length < 512) text += String(chunk); });
    request.on("error", (error) => done({ status: 0, reason: String(error?.message ?? error) }));
    request.on("end", () => {
      let reason = "";
      try { reason = String(JSON.parse(text)?.reason ?? ""); } catch { reason = ""; }
      done({ status, reason });
    });
    request.end(JSON.stringify({ aps: { "content-available": 1 } }));
  });
  return readApnsVerdict(answer);
}

/**
 * Ask Google. The OAuth mint first, because its refusal is the one that names the actual fault, and
 * then the free dry run.
 */
export async function proveFcmCredential({ serviceAccount, projectId, fetchImpl = fetch, nowMs = Date.now(), timeoutMs = 10_000 }) {
  let assertion;
  try { assertion = fcmAssertion({ serviceAccount, nowMs }); }
  catch { return { ok: false, why: "That service account could not sign a token, so nothing was stored." }; }
  let minted;
  try {
    minted = await fetchImpl(serviceAccount.token_uri || GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return { ok: false, why: "Google did not answer the token request, so nothing could be checked and nothing was stored." }; }
  const tokenBody = await minted.json?.().catch(() => null) ?? null;
  if (minted.status !== 200 || typeof tokenBody?.access_token !== "string") {
    // Google's own word for it, and never the assertion.
    return { ok: false, why: `Google would not mint a messaging token for that service account (HTTP ${minted.status}${tokenBody?.error ? ` ${String(tokenBody.error)}` : ""}).` };
  }
  let sent;
  try {
    sent = await fetchImpl(`${FCM_SEND_BASE}/${encodeURIComponent(projectId)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenBody.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ validate_only: true, message: { token: PROOF_DEVICE_TOKEN, data: { check: "1" } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return { ok: false, why: "Google did not answer the dry run, so nothing could be checked and nothing was stored." }; }
  const body = await sent.json?.().catch(() => null) ?? null;
  const code = String(body?.error?.details?.[0]?.errorCode ?? body?.error?.status ?? "");
  return readFcmVerdict({ status: Number(sent.status) || 0, code });
}
