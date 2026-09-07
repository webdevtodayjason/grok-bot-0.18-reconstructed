#!/usr/bin/env node
// verify-mail.mjs -- the agent email gate (MAIL-1, docs/MAIL.md).
//
// It drives the relay's mail edge over HTTP and nothing else: no docker, no gateway call, no file
// on the box. That is deliberate. The receive side is the relay's (ui/mail-edge.mjs, mounted from
// ui/server.mjs the way handleJobBus is), so a gate that reached past it would stop measuring the
// thing Resend actually calls.
//
// Two shapes of run.
//
//   Read only (the default, safe against a live relay):
//     open      GET /mail/settings with no credential is the relay's own 401
//     shape     GET /mail/settings with a session answers the documented keys
//     secrets   that answer carries no apiKey and no webhookSecret, only "set" / "not set"
//     hook      POST /hooks/resend with no signature is refused, and refused as the WEBHOOK
//               (503 not_configured with no secret stored, 401 invalid_signature with one),
//               never as the console door
//     cap       a body over 256 KB is 413, not buffered
//
//   --stub (mutating; only against a relay whose mail is not configured yet):
//     everything above, plus a stub Resend API this script runs itself, a generated signing
//     secret and a generated key written through POST /mail/settings, and then
//       delivered  a signed email.received to <first agent's address> answers 200 delivered
//       ledger     that row is in GET /mail/settings recent, with the same email_id
//       forged     the same body with a wrong signature is 401 invalid_signature
//       replay     the same email_id signed again is 200 ignored duplicate
//       withheld   the settings read still returns neither generated value
//     and the settings it borrowed go back in a finally that also runs on SIGTERM and SIGINT
//     (GATE-4: a gate killed by its timeout that never restores is worse than a gate that fails).
//
// The stub run REFUSES to start when the relay already holds a key or a signing secret. Secrets on
// this plane are write-only, so the gate cannot put back what it cannot read, and clearing Jason's
// live Resend key to finish a test run is not a trade this gate gets to make. Point it at a relay
// with mail not yet configured, or run it without --stub.
//
// The delivery leg really does send a message into the first agent's conversation. That is the
// product: a mail lands as a prompt. The subject says it came from this gate.
//
//   node scripts/verify-mail.mjs --url https://console.titanium.bot
//   node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub
//   node scripts/verify-mail.mjs --url https://console.titanium.bot --stub --stub-base http://<this mac>:7893
//
// The session comes the way scripts/verify-deploy.mjs gets one: a page request carrying the
// gateway bearer is answered and given a gb_session cookie. The bearer is read from --token, from
// SAND_HOST_GATEWAY_TOKEN, from a local SAND_PROFILE_DIRS profile, or over ssh from the server,
// held in memory, and never printed or written down.
//
// Env: TITANBOT_URL, SAND_HOST_GATEWAY_TOKEN, SAND_PROFILE_DIRS, TITANBOT_HOST (ssh destination,
//      default dell-remote), TITANBOT_ROOT (default /home/sem/titanbot), MAIL_STUB_PORT (default 7893, or the port in --stub-base).
import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const flag = (name) => {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline != null) return inline.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-mail.mjs -- the agent email gate (MAIL-1, docs/MAIL.md).",
    "",
    "  node scripts/verify-mail.mjs --url https://console.titanium.bot",
    "  node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub",
    "",
    "Without --stub it changes nothing: it proves the console door in front of /mail/settings, the",
    "shape of that answer, that the answer withholds both secrets, that an unsigned POST to",
    "/hooks/resend is refused by the webhook rather than by the console door, and that an oversized",
    "body is refused rather than buffered.",
    "",
    "With --stub it also runs a stub Resend API of its own, writes a generated signing secret and a",
    "generated key, delivers one signed synthetic email to the first agent's address, and checks the",
    "ledger row, a forged signature, a replayed email_id and the withholding again. It restores the",
    "settings it borrowed, including on SIGTERM and SIGINT, and refuses to start at all if the relay",
    "already holds a key or a signing secret.",
    "",
    "  --url <base>         the relay (default $TITANBOT_URL, else http://127.0.0.1:7777)",
    "  --stub               run the mutating legs against a stub Resend API",
    "  --stub-base <url>    the address the RELAY should use to reach that stub; required when the",
    "                       relay is not on this machine's loopback",
    "  --token <bearer>     the gateway bearer (default $SAND_HOST_GATEWAY_TOKEN, a local profile,",
    "                       or read over ssh from $TITANBOT_HOST)",
    "",
    "Exit: 0 every check passed, 1 a check failed, 2 the run could not start.",
  ].join("\n"));
  process.exit(0);
}

const URL_BASE = (flag("url") ?? process.env.TITANBOT_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");
const STUB = process.argv.includes("--stub");
const SSH_HOST = process.env.TITANBOT_HOST ?? "dell-remote";
const SSH_ROOT = process.env.TITANBOT_ROOT ?? "/home/sem/titanbot";
// A domain that can never be anybody's: .invalid is reserved for exactly this. Routing matches the
// To address's domain against the stored one, so a real domain here would be a live-fire test.
const GATE_DOMAIN = "mail-gate.invalid";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const die = (message) => { console.error(`\nverify-mail: ${message}`); process.exit(2); };

// ---------------------------------------------------------------- the bearer, and a session

const ssh = (command) => new Promise((resolve, reject) =>
  execFile("ssh", ["-o", "BatchMode=yes", SSH_HOST, command], { maxBuffer: 8 << 20 },
    (error, out, err) => (error ? reject(new Error(String(err || error.message).slice(0, 200))) : resolve(String(out)))));

async function resolveToken() {
  const explicit = flag("token") ?? process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return { token: explicit, from: "the argument or the environment" };
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try {
      const token = JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token;
      if (token) return { token, from: `${dir}/local-docker-vm.json` };
    } catch { /* next */ }
  }
  try {
    const token = JSON.parse(await ssh(`cat ${SSH_ROOT}/profile/local-docker-vm.json`)).token;
    if (token) return { token, from: `${SSH_HOST}:${SSH_ROOT}/profile/local-docker-vm.json` };
  } catch { /* fall through to the refusal below */ }
  return die("no gateway bearer. Pass --token, set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS, "
    + `or make sure ssh ${SSH_HOST} can read ${SSH_ROOT}/profile/local-docker-vm.json`);
}

const hit = (path, init = {}) => fetch(`${URL_BASE}${path}`, {
  redirect: "manual", signal: AbortSignal.timeout(30_000), ...init,
});

const { token: TOKEN, from: TOKEN_FROM } = await resolveToken();

step(`the mail edge on ${URL_BASE}`);
console.log(`  INFO  bearer read from ${TOKEN_FROM} (value withheld)`);

// The way in without the password, exactly as verify-deploy.mjs does it: a PAGE request carrying
// the gateway bearer is answered and handed a gb_session cookie, and that cookie is what every
// console-authenticated route below is called with.
const bearerPage = await hit("/", { headers: { accept: "text/html", authorization: `Bearer ${TOKEN}` } });
const SESSION = /(?:^|,\s*)(gb_session=[^;]+)/.exec(bearerPage.headers.get("set-cookie") ?? "")?.[1] ?? "";
if (SESSION.length === 0) {
  die(`the relay gave no session for a page request carrying the bearer (HTTP ${bearerPage.status}). `
    + "Either the bearer is stale or this is not the relay.");
}

const getSettings = async (headers = { cookie: SESSION }) => {
  const res = await hit("/mail/settings", { headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* left null; the caller reports the status */ }
  return { status: res.status, headers: res.headers, body, text };
};

const postSettings = async (patch) => {
  const res = await hit("/mail/settings", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: SESSION },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* left null */ }
  return { status: res.status, body, text };
};

const postHook = async (raw, headers = {}) => {
  const res = await hit("/hooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* left null */ }
  return { status: res.status, headers: res.headers, body, text };
};

// ---------------------------------------------------------------- read-only legs

step("the console door in front of the settings");
const anonymous = await getSettings({});
check(anonymous.status === 401 && anonymous.headers.get("x-relay-auth") === "required",
  "GET /mail/settings with no credential is the relay's own 401",
  `HTTP ${anonymous.status}, x-relay-auth ${anonymous.headers.get("x-relay-auth") ?? "absent"}`);

step("the settings a session reads back");
const before = await getSettings();
check(before.status === 200 && before.body != null && typeof before.body === "object",
  "GET /mail/settings with a session answers 200 JSON", `HTTP ${before.status} ${before.text.slice(0, 160)}`);

const settings = before.body ?? {};
const WANTED = ["enabled", "domain", "fromName", "apiBase", "catchAllAgentId", "routes",
  "apiKeySet", "webhookSecretSet", "webhookUrl", "addresses", "recent"];
const missing = WANTED.filter((key) => !(key in settings));
check(missing.length === 0, "it carries every documented key", missing.length === 0
  ? WANTED.join(", ") : `missing ${missing.join(", ")}`);
check(typeof settings.apiKeySet === "boolean" && typeof settings.webhookSecretSet === "boolean",
  "the two secrets are reported as booleans, set or not set",
  `apiKeySet ${JSON.stringify(settings.apiKeySet)}, webhookSecretSet ${JSON.stringify(settings.webhookSecretSet)}`);
check(!("apiKey" in settings) && !("webhookSecret" in settings),
  "and neither secret's value is in the answer at all",
  Object.keys(settings).filter((key) => /key|secret/i.test(key)).join(", ") || "no key-shaped field");
check(Array.isArray(settings.addresses) && Array.isArray(settings.recent),
  "addresses and recent are arrays",
  `${Array.isArray(settings.addresses) ? settings.addresses.length : "?"} address(es), `
  + `${Array.isArray(settings.recent) ? settings.recent.length : "?"} recent row(s)`);
check(typeof settings.webhookUrl === "string" && settings.webhookUrl.endsWith("/hooks/resend"),
  "the webhook URL to paste into Resend ends at /hooks/resend", String(settings.webhookUrl ?? "absent"));

step("the webhook's own door");
const unsigned = await postHook(JSON.stringify({ type: "email.received", data: { email_id: "no-signature" } }));
const expected = settings.webhookSecretSet === true ? 401 : 503;
const expectedError = settings.webhookSecretSet === true ? "invalid_signature" : "not_configured";
check(unsigned.status === expected && unsigned.body?.error === expectedError,
  settings.webhookSecretSet === true
    ? "an unsigned POST /hooks/resend is 401 invalid_signature (a secret is stored)"
    : "an unsigned POST /hooks/resend is 503 not_configured (no secret is stored)",
  `HTTP ${unsigned.status} ${unsigned.text.slice(0, 120)}`);
// The point of this one: Resend holds no console session and never will, so the webhook must
// answer for itself. A relay-auth marker here would mean the hook is behind the console's login.
check(unsigned.headers.get("x-relay-auth") == null,
  "and that refusal is the webhook's, not the console login's",
  unsigned.headers.get("x-relay-auth") ?? "no x-relay-auth header");

// A body this size is past the relay's drain limit, so the refusal is written and the request is
// then destroyed. That is the shape the login uses (server.mjs drainThenEnd / endAndClose) and it
// can surface here as a socket error instead of a response, so the throw is reported rather than
// crashing the run.
const oversize = await postHook("x".repeat(300 * 1024)).catch((error) => ({ status: 0, headers: new Headers(), body: null, text: String(error?.message ?? error) }));
check(oversize.status === 413, "a body over the 256 KB cap is refused, not buffered",
  oversize.status === 0 ? `the connection was reset before an answer arrived: ${oversize.text.slice(0, 120)}` : `HTTP ${oversize.status}`);

if (!STUB) {
  console.log("\n  INFO  read-only run: the delivery, ledger, forged-signature and replay legs need "
    + "--stub and a relay whose mail is not configured yet.");
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)  ${URL_BASE}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- the stub run

if (settings.apiKeySet === true || settings.webhookSecretSet === true) {
  die("this relay already holds a Resend key or a signing secret, and both are write-only, so this "
    + "gate could not put them back. Run without --stub, or point --stub at a relay whose mail is "
    + "not configured yet.");
}

// Where the relay has to reach the stub. Loopback works only when the relay runs on this machine.
// The listen port follows the port in --stub-base, because a base advertised on one port and a
// listener on another is a run that fails as "fetch_failed" and blames the relay for it.
const relayHost = new URL(URL_BASE).hostname;
const relayIsLocal = ["127.0.0.1", "::1", "localhost"].includes(relayHost);
const stubBaseFlag = flag("stub-base");
if (stubBaseFlag != null) {
  try { new URL(stubBaseFlag); } catch { die(`--stub-base ${stubBaseFlag} is not a URL`); }
}
const STUB_PORT = Number(process.env.MAIL_STUB_PORT
  ?? (stubBaseFlag != null ? (new URL(stubBaseFlag).port || (new URL(stubBaseFlag).protocol === "https:" ? 443 : 80)) : 7893));
const STUB_BASE = (stubBaseFlag ?? (relayIsLocal ? `http://127.0.0.1:${STUB_PORT}` : "")).replace(/\/+$/, "");
if (STUB_BASE.length === 0) {
  die(`the relay is at ${relayHost}, which cannot reach a stub on this machine's loopback. Pass `
    + "--stub-base <url> naming an address the relay can reach (the stub binds 0.0.0.0 then).");
}
const STUB_BIND = relayIsLocal && stubBaseFlag == null ? "127.0.0.1" : "0.0.0.0";

// Everything this run invents. None of it is a real credential and none of it is printed.
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const API_KEY = `re_gate_${randomBytes(16).toString("hex")}`;
const EMAIL_ID = `gate_${randomBytes(9).toString("hex")}`;
const MESSAGE_ID = `<${randomBytes(8).toString("hex")}@mail-gate.invalid>`;
const SENDER = "Mail Gate <gate@sender.invalid>";
const SUBJECT = `verify-mail probe ${EMAIL_ID.slice(-6)}`;
const ATTACHMENT = { name: "probe.txt", content_type: "text/plain", size: 12 };

// The stub Resend API. Two routes, both bearer-checked, because a relay that fetches the message
// without its key would look identical to a relay that fetched it correctly.
let stubFetches = 0;
let stubBadAuth = 0;
let stubDownloads = 0;
const stub = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://stub").pathname;
  const answer = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  // The download link Resend hands out is pre-signed and carries no bearer, so this path takes
  // none either. It is only counted: the contract says the relay lists an attachment and never
  // fetches it, and a byte pulled here would be the relay putting mail bodies on its own disk.
  if (path.startsWith("/download/")) { stubDownloads += 1; return answer(200, { ok: true }); }
  if ((req.headers.authorization ?? "") !== `Bearer ${API_KEY}`) { stubBadAuth += 1; return answer(401, { error: "unauthorized" }); }
  if (path === `/emails/receiving/${EMAIL_ID}`) {
    stubFetches += 1;
    return answer(200, {
      id: EMAIL_ID,
      from: SENDER,
      to: [ADDRESS],
      subject: SUBJECT,
      text: "One line of body, so the prompt has something in it.",
      html: "<p>One line of body, so the prompt has something in it.</p>",
      headers: { "message-id": MESSAGE_ID },
      message_id: MESSAGE_ID,
      created_at: new Date().toISOString(),
    });
  }
  if (path === `/emails/receiving/${EMAIL_ID}/attachments`) {
    return answer(200, {
      data: [{
        ...ATTACHMENT,
        download_url: `${STUB_BASE}/download/${EMAIL_ID}/probe.txt`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }],
    });
  }
  return answer(404, { error: "not_found" });
});

// The signature Resend puts on a webhook: signed content is id.timestamp.body, the key is the
// base64 bytes after whsec_, and the header is space-separated "v1,<base64>" entries. Ported from
// ~/code/titanium-mail/apps/web/lib/svix.ts, which is the implementation the relay ports too, so a
// disagreement between the two shows up here rather than in production.
const svixKey = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
const sign = (id, timestamp, raw) =>
  createHmac("sha256", svixKey).update(`${id}.${timestamp}.${raw}`, "utf8").digest("base64");
const svixHeaders = (raw, { signature = null, id = `msg_${randomBytes(8).toString("hex")}`, timestamp = Math.floor(Date.now() / 1000) } = {}) => ({
  "svix-id": id,
  "svix-timestamp": String(timestamp),
  "svix-signature": `v1,${signature ?? sign(id, timestamp, raw)}`,
});

// Proof the gate's own signer agrees with itself before it accuses the relay of anything.
{
  const raw = "{}";
  const id = "msg_selftest";
  const ts = "1757000000";
  const mine = Buffer.from(sign(id, ts, raw), "base64");
  const again = Buffer.from(sign(id, ts, raw), "base64");
  check(mine.length === 32 && timingSafeEqual(mine, again),
    "the gate's own Svix signer is deterministic and 32 bytes wide", `${mine.length} bytes`);
}

// The settings this run borrows, and the restore that always follows. Written before anything is
// changed so a kill between the two cannot lose it.
const BASELINE = {
  enabled: settings.enabled ?? false,
  domain: settings.domain ?? "",
  fromName: settings.fromName ?? "",
  apiBase: settings.apiBase ?? "",
  catchAllAgentId: settings.catchAllAgentId ?? null,
  routes: settings.routes ?? {},
  apiKey: null,
  webhookSecret: null,
};
let restored = false;
async function restore(reason) {
  if (restored) return;
  restored = true;
  try {
    const put = await postSettings(BASELINE);
    console.log(`  INFO  settings restored (${reason}): HTTP ${put.status}, both secrets cleared`);
  } catch (error) {
    console.log(`  FAIL  the settings could not be restored (${reason}) -- ${String(error?.message ?? error)}`);
    failures += 1;
  }
  try { stub.close(); } catch { /* already down */ }
}
// GATE-4: a gate killed by its timeout never reaches its finally, and a run that leaves a
// generated key and a .invalid domain on a relay is a run nobody can repeat.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { restore(signal).then(() => process.exit(143)); });
}

// ADDRESS is read after the domain is written, but the stub closure above refers to it, so it is
// declared here and filled in below. A stub request before that point can only be a bug.
let ADDRESS = "";

try {
  await new Promise((resolve, reject) => {
    stub.on("error", reject);
    stub.listen(STUB_PORT, STUB_BIND, resolve);
  });
  console.log(`  INFO  stub Resend API on ${STUB_BIND}:${STUB_PORT}, advertised to the relay as ${STUB_BASE}`);

  step("the settings this run writes");
  const wrote = await postSettings({
    enabled: true,
    domain: GATE_DOMAIN,
    fromName: "Mail Gate",
    apiBase: STUB_BASE,
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    routes: {},
    catchAllAgentId: null,
  });
  check(wrote.status === 200 && wrote.body?.apiKeySet === true && wrote.body?.webhookSecretSet === true,
    "POST /mail/settings stores the key and the signing secret and reports both as set",
    `HTTP ${wrote.status} ${wrote.text.slice(0, 160)}`);
  check(!("apiKey" in (wrote.body ?? {})) && !("webhookSecret" in (wrote.body ?? {})),
    "and the answer to the write echoes neither value",
    wrote.text.includes(API_KEY) || wrote.text.includes(WEBHOOK_SECRET) ? "a generated value came back" : "neither value came back");

  const addresses = Array.isArray(wrote.body?.addresses) ? wrote.body.addresses : [];
  check(addresses.length > 0 && addresses.every((row) => String(row?.address ?? "").endsWith(`@${GATE_DOMAIN}`)),
    "every agent on the roster is given an address at the domain just set",
    addresses.length > 0 ? `${addresses.length}: ${addresses.slice(0, 3).map((row) => row.address).join(", ")}${addresses.length > 3 ? " ..." : ""}` : "none");
  if (addresses.length === 0) throw new Error("no agent address to deliver to; the roster read back empty");
  ADDRESS = addresses[0].address;
  const TARGET = addresses[0];

  step(`one signed email to ${ADDRESS}`);
  const event = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: { email_id: EMAIL_ID, from: SENDER, to: [ADDRESS], subject: SUBJECT },
  });
  const delivered = await postHook(event, svixHeaders(event));
  check(delivered.status === 200 && delivered.body?.delivered?.agentId === TARGET.agentId,
    "a signed email.received is 200 and names the agent it was delivered to",
    `HTTP ${delivered.status} ${delivered.text.slice(0, 200)}`);
  check(stubFetches >= 1 && stubBadAuth === 0,
    "the relay fetched the full message from the API base with the stored key",
    `${stubFetches} fetch(es), ${stubBadAuth} refused for a bad bearer`);
  check(stubDownloads === 0, "and it listed the attachment without downloading it",
    `${stubDownloads} download(s) of the attachment link`);

  step("the ledger");
  const after = await getSettings();
  const recent = Array.isArray(after.body?.recent) ? after.body.recent : [];
  const row = recent.find((entry) => entry?.email_id === EMAIL_ID) ?? null;
  check(row != null, "the delivery is a row in GET /mail/settings recent",
    row != null ? `outcome ${row.outcome}, to ${row.agentName ?? row.agentId}` : `${recent.length} row(s), none with this email_id`);
  check(row?.subject === SUBJECT && String(row?.from ?? "").includes("gate@sender.invalid"),
    "that row carries the sender and the subject", `from ${row?.from ?? "?"}, subject ${row?.subject ?? "?"}`);
  const leaked = [after.text.includes(API_KEY) ? "the key" : null, after.text.includes(WEBHOOK_SECRET) ? "the signing secret" : null].filter(Boolean);
  check(leaked.length === 0, "and the settings read still withholds both generated values",
    leaked.length === 0 ? "neither value appears in the answer" : `${leaked.join(" and ")} came back in the answer`);

  step("a forged signature and a replay");
  const forgedEvent = JSON.stringify({
    type: "email.received",
    data: { email_id: `${EMAIL_ID}-forged`, from: SENDER, to: [ADDRESS], subject: SUBJECT },
  });
  const forged = await postHook(forgedEvent, svixHeaders(forgedEvent, {
    signature: randomBytes(32).toString("base64"),
  }));
  check(forged.status === 401 && forged.body?.error === "invalid_signature",
    "a body signed with the wrong key is 401 invalid_signature", `HTTP ${forged.status} ${forged.text.slice(0, 120)}`);

  const fetchesBeforeReplay = stubFetches;
  const replay = await postHook(event, svixHeaders(event));
  check(replay.status === 200 && replay.body?.ignored === "duplicate",
    "the same email_id signed again is 200 ignored duplicate, so Resend stops retrying",
    `HTTP ${replay.status} ${replay.text.slice(0, 120)}`);
  check(stubFetches === fetchesBeforeReplay,
    "and the duplicate is dropped before the message is fetched again",
    `${stubFetches - fetchesBeforeReplay} extra fetch(es)`);

  const ledgerAfterReplay = await getSettings();
  const rowsForThisEmail = (Array.isArray(ledgerAfterReplay.body?.recent) ? ledgerAfterReplay.body.recent : [])
    .filter((entry) => entry?.email_id === EMAIL_ID && entry?.outcome === "delivered");
  check(rowsForThisEmail.length === 1, "the ledger holds exactly one delivered row for that email",
    `${rowsForThisEmail.length} row(s)`);
} catch (error) {
  check(false, "the stub run finished without throwing", String(error?.message ?? error));
} finally {
  await restore("end of run");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)  ${URL_BASE}`);
process.exit(failures === 0 ? 0 : 1);
