#!/usr/bin/env node
// verify-mail.mjs -- the agent email gate (MAIL-1, docs/MAIL.md).
//
// It drives the PUBLIC surface, the way the job bus gate does: every leg goes through
// /hooks/resend and /mail/settings on a running relay, exactly as Resend and the console reach
// them. Nothing here calls the gateway directly.
//
// In order:
//   closed    an unsigned POST /hooks/resend answers 503 not_configured while no secret is set
//   shape     GET /mail/settings answers the contract's fields and no secret, ever
//   signed    with a generated secret and a stub Resend, a signed email.received addressed to the
//             first agent's own address answers 200 delivered, and the ledger row appears in
//             GET /mail/settings.recent
//   forged    the same body signed with a different secret answers 401 invalid_signature
//   replay    the same email_id again answers 200 duplicate, and is not delivered twice
//   clean     the settings are put back and both secrets are cleared, whatever happened above
//
// The mutating legs need --stub, because they write this relay's real mail settings: the gate
// stands up a tiny HTTP server of its own serving one synthetic received email and one attachment
// list. Without --stub only the non-mutating legs run, which is what a production relay that is
// already configured gets.
//
// --stub is refused unless it is safe to run, and there are three rules, because this gate clears
// both secrets on the way out and a cleared Resend signing secret cannot be got back (Resend shows
// it once, when the webhook is made):
//
//   the target must be loopback         a relay somewhere else is somebody's working relay
//   neither secret may be stored        a relay with a key in it is a relay in use
//   the relay must already be reading   the address Resend is read at is a relay environment
//   Resend at a loopback address        variable now, so the stub has to be where it looks:
//                                       start the relay with GROK_BOT_MAIL_API_BASE=http://127.0.0.1:7809
//
//   node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub
//   node scripts/verify-mail.mjs --url https://console.titanium.bot
//
// The way in is the relay's own bearer, the same credential scripts/verify-deploy.mjs uses: it is
// already full access, so being let in with it is not a privilege this gate invented, and it means
// the gate never needs the console password. --token, then SAND_HOST_GATEWAY_TOKEN, then the
// local-docker-vm.json in SAND_PROFILE_DIRS. It is never printed.
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-mail.mjs -- the agent email gate (MAIL-1, docs/MAIL.md).",
    "",
    "  node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub",
    "  node scripts/verify-mail.mjs --url https://console.titanium.bot",
    "",
    "Legs: the unconfigured hook answers 503, the settings shape carries no secret, a signed",
    "synthetic email is delivered to the first agent and lands in the ledger, a forged signature",
    "is 401, a replay is a duplicate, and the settings are restored with both secrets cleared.",
    "",
    "--stub runs the mutating legs against a stub Resend this gate starts locally. It is refused",
    "unless --url is loopback, neither secret is stored on that relay, and the relay was started",
    "with GROK_BOT_MAIL_API_BASE pointing at a loopback address, which is where the stub listens.",
    "Without --stub only the non-mutating legs run, so a working relay is never overwritten.",
    "",
    "Env: MAIL_GATE_URL (the default for --url), SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS",
    "     (the relay bearer). The stub's port comes from the relay's own GROK_BOT_MAIL_API_BASE.",
  ].join("\n"));
  process.exit(0);
}

const flag = (name, fallback = null) => {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline != null) return inline.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

const BASE = String(flag("url", process.env.MAIL_GATE_URL ?? "http://127.0.0.1:7777")).replace(/\/+$/, "");
const STUB = process.argv.includes("--stub");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const hostOf = (value) => { try { return new URL(value).hostname.toLowerCase(); } catch { return ""; } };
const isLoopback = (value) => LOOPBACK.has(hostOf(value));

const TOKEN = (() => {
  const given = flag("token", process.env.SAND_HOST_GATEWAY_TOKEN?.trim() || null);
  if (given != null && given.length > 0) return given;
  for (const dir of String(process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (dir.trim().length === 0) continue;
    try {
      const token = JSON.parse(readFileSync(`${dir.trim()}/local-docker-vm.json`, "utf8")).token;
      if (typeof token === "string" && token.length > 0) return token;
    } catch { /* next */ }
  }
  return null;
})();

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const done = () => { console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`); process.exit(failures === 0 ? 0 : 1); };

if (TOKEN == null) {
  console.log("  FAIL  the relay bearer is readable -- pass --token, or set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
  console.log("\n1 FAILED");
  process.exit(1);
}

const auth = { authorization: `Bearer ${TOKEN}` };
const hit = (route, init = {}) => fetch(`${BASE}${route}`, { redirect: "manual", ...init });
const readSettings = async () => {
  const response = await hit("/mail/settings", { headers: auth });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};
const writeSettings = async (patch) => {
  const response = await hit("/mail/settings", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(patch),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// The synthetic email the stub serves and the event that announces it.
const EMAIL_ID = `em_gate_${randomBytes(6).toString("hex")}`;
const MESSAGE_ID = `<${randomBytes(8).toString("hex")}@gate.invalid>`;
const BODY_LINE = `verify-mail ${randomBytes(4).toString("hex")}`;

function startStub(toAddress, port) {
  const message = {
    from: "Gate <gate@example.invalid>", to: [toAddress], subject: "verify-mail synthetic message",
    text: BODY_LINE, message_id: MESSAGE_ID, created_at: new Date().toISOString(),
  };
  const attachments = { data: [{
    name: "note.txt", content_type: "text/plain", size: 12,
    download_url: "https://files.example.invalid/note.txt", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }] };
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/attachments") ? attachments : message));
  });
  return {
    seen,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    },
    stop() { server.close(); },
  };
}

const svixKey = (secret) => Buffer.from(secret.replace(/^whsec_/, ""), "base64");
function signedPost(body, secret, at = Math.floor(Date.now() / 1000)) {
  const id = `msg_${randomBytes(6).toString("hex")}`;
  const signature = `v1,${createHmac("sha256", svixKey(secret)).update(`${id}.${at}.${body}`, "utf8").digest("base64")}`;
  return hit("/hooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(at), "svix-signature": signature },
    body,
  });
}

const receivedEvent = (to) => JSON.stringify({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: { email_id: EMAIL_ID, to: [to], from: "gate@example.invalid", subject: "verify-mail synthetic message" },
});

console.log(`verify-mail against ${BASE}${STUB ? " (with a stub Resend)" : " (read-only legs only)"}`);

// ---- the shape, and the door ------------------------------------------------------------------

step("the settings the console reads");
const before = await readSettings();
check(before.status === 200 && before.body != null, "GET /mail/settings answers on the relay bearer", `HTTP ${before.status}`);
if (before.status !== 200 || before.body == null) done();

for (const field of ["enabled", "domain", "fromName", "apiBase", "catchAllAgentId", "routes",
  "apiKeySet", "webhookSecretSet", "webhookUrl", "addresses", "recent"]) {
  check(field in before.body, `the answer carries ${field}`);
}
check(!("apiKey" in before.body) && !("webhookSecret" in before.body),
  "and it carries neither secret as a value", Object.keys(before.body).join(","));
check(typeof before.body.apiKeySet === "boolean" && typeof before.body.webhookSecretSet === "boolean",
  "the two secrets are reported as set or not set",
  `apiKeySet ${before.body.apiKeySet}, webhookSecretSet ${before.body.webhookSecretSet}`);
check(String(before.body.webhookUrl ?? "").endsWith("/hooks/resend"),
  "the webhook address is this relay's own /hooks/resend", String(before.body.webhookUrl));

const unauthenticated = await hit("/mail/settings");
check(unauthenticated.status === 401 || (unauthenticated.status >= 300 && unauthenticated.status < 400),
  "and it is behind the console login without a credential", `HTTP ${unauthenticated.status}`);

if (!STUB) {
  step("the mutating legs");
  console.log("  INFO  skipped: they overwrite this relay's mail settings. Re-run with --stub to measure them.");
  done();
}

// ---- may the mutating legs run here at all ------------------------------------------------------
// They clear both secrets on the way out, and a cleared Resend signing secret is gone: Resend shows
// it once, when the webhook is made. So this is a refusal, not a warning, and it happens before the
// first write.
step("is it safe to run the mutating legs against this relay");
const refusals = [];
if (!isLoopback(BASE)) {
  refusals.push(`--url is ${BASE}, which is not this machine. These legs write this relay's mail `
    + "settings and clear both secrets, so they only run against a relay on 127.0.0.1.");
}
if (before.body.apiKeySet === true || before.body.webhookSecretSet === true) {
  refusals.push("this relay already has a Resend key or a signing secret saved, and clearing one is "
    + "not something this gate can undo, because Resend shows a signing secret once. Start a scratch "
    + "relay with no mail settings and point --url at that.");
}
const relayApiBase = String(before.body.apiBase ?? "");
if (!isLoopback(relayApiBase)) {
  refusals.push(`this relay reads Resend at ${relayApiBase || "no address at all"}, so the stub would `
    + "never be read. The address is a relay environment variable now, not a setting: start the "
    + "scratch relay with GROK_BOT_MAIL_API_BASE=http://127.0.0.1:7809 and run this again.");
}
for (const line of refusals) check(false, "the mutating legs are refused here", line);
if (refusals.length > 0) done();
check(true, "loopback relay, no secrets stored, reading Resend on this machine", relayApiBase);
const STUB_PORT = Number(new URL(relayApiBase).port || 80);

// ---- the hook, end to end ---------------------------------------------------------------------

const restore = {
  enabled: before.body.enabled === true,
  domain: before.body.domain ?? "",
  fromName: before.body.fromName ?? "",
  catchAllAgentId: before.body.catchAllAgentId ?? "",
  routes: before.body.routes ?? {},
  // Cleared on the way out, whatever happened: this gate wrote a secret of its own invention and
  // must not leave it behind pretending to be a working configuration.
  apiKey: null,
  webhookSecret: null,
};

const stubDomain = "verify-mail.invalid";
const firstAgent = (before.body.addresses ?? [])[0] ?? null;
let stub = null;

try {
  step("an unconfigured hook");
  const cleared = await writeSettings({ webhookSecret: null, apiKey: null, domain: stubDomain });
  check(cleared.status === 200 && cleared.body?.webhookSecretSet === false,
    "the signing secret can be cleared through the console", `HTTP ${cleared.status}`);
  const unsigned = await hit("/hooks/resend", {
    method: "POST", headers: { "content-type": "application/json" }, body: receivedEvent(`titan@${stubDomain}`),
  });
  const unsignedBody = await unsigned.json().catch(() => null);
  check(unsigned.status === 503 && unsignedBody?.error === "not_configured",
    "an unsigned POST /hooks/resend answers 503 not_configured", `HTTP ${unsigned.status} ${JSON.stringify(unsignedBody)}`);

  step("a signed email");
  // The roster the relay reported, so the address this gate sends to is one an agent really owns.
  const roster = (await readSettings()).body?.addresses ?? [];
  const target = roster[0] ?? firstAgent;
  // Not an early exit: the finally below has to run, or this gate leaves its own invented secret
  // and a made-up domain on the operator's relay.
  check(target != null, "the relay reports at least one agent to address the mail to",
    target == null ? "the roster is empty" : `${target.name} at ${target.address}`);
  if (target == null) throw Object.assign(new Error("no agent to address"), { handled: true });
  const to = `${String(target.address).split("@")[0]}@${stubDomain}`;
  // On the port the relay already reads Resend at, because that address is the relay's own
  // environment variable and nothing this gate sends can move it.
  stub = startStub(to, STUB_PORT);
  await stub.start();
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const configured = await writeSettings({
    enabled: true, domain: stubDomain, fromName: "verify-mail",
    apiKey: `re_gate_${randomBytes(12).toString("hex")}`, webhookSecret: secret,
  });
  check(configured.status === 200 && configured.body?.webhookSecretSet === true && configured.body?.apiKeySet === true,
    "the key and the signing secret are stored and reported as set", `HTTP ${configured.status}`);
  check(!JSON.stringify(configured.body ?? {}).includes(secret),
    "and the save answers without echoing the secret back");

  const delivered = await signedPost(receivedEvent(to), secret);
  const deliveredBody = await delivered.json().catch(() => null);
  check(delivered.status === 200 && deliveredBody?.delivered?.agentId === target.agentId,
    `a signed email to ${to} is delivered to ${target.name}`,
    `HTTP ${delivered.status} ${JSON.stringify(deliveredBody)}`);
  check(stub.seen.includes(`/emails/receiving/${EMAIL_ID}`),
    "the relay read the message back out of Resend with the stored key", stub.seen.join(" "));

  const after = await readSettings();
  const row = (after.body?.recent ?? []).find((entry) => entry.email_id === EMAIL_ID);
  check(row != null, "the ledger row is on GET /mail/settings.recent", JSON.stringify((after.body?.recent ?? [])[0] ?? null));
  if (row != null) {
    check(row.outcome === "delivered" && row.agentId === target.agentId,
      "and it names the agent it went to and says it was delivered", JSON.stringify(row));
    check(!JSON.stringify(row).includes(BODY_LINE), "and it carries no body text", JSON.stringify(row));
  }
  check(!JSON.stringify(after.body ?? {}).includes(secret) && !JSON.stringify(after.body ?? {}).includes("re_gate_"),
    "GET /mail/settings still returns neither secret");

  step("a forged signature and a replay");
  const forged = await signedPost(receivedEvent(to), `whsec_${randomBytes(24).toString("base64")}`);
  const forgedBody = await forged.json().catch(() => null);
  check(forged.status === 401 && forgedBody?.error === "invalid_signature",
    "a body signed with the wrong secret answers 401 invalid_signature", `HTTP ${forged.status} ${JSON.stringify(forgedBody)}`);

  const stale = await signedPost(receivedEvent(to), secret, Math.floor(Date.now() / 1000) - 400);
  check(stale.status === 401, "and a signature from outside the five minute window is refused too", `HTTP ${stale.status}`);

  const replay = await signedPost(receivedEvent(to), secret);
  const replayBody = await replay.json().catch(() => null);
  check(replay.status === 200 && replayBody?.ignored === "duplicate",
    "the same email_id again answers 200 duplicate", `HTTP ${replay.status} ${JSON.stringify(replayBody)}`);
  const rows = ((await readSettings()).body?.recent ?? []).filter((entry) => entry.email_id === EMAIL_ID);
  check(rows.length === 1, "and it wrote no second ledger row", `${rows.length} row(s)`);

  step("the receiving switch");
  // The card says "Mail sent to your agents is not being taken in" when this is off, so the hook
  // has to mean it. A different email_id, so this is not the duplicate answering.
  const offEvent = JSON.stringify({
    type: "email.received", created_at: new Date().toISOString(),
    data: { email_id: `${EMAIL_ID}_off`, to: [to], from: "gate@example.invalid", subject: "verify-mail while off" },
  });
  const turnedOff = await writeSettings({ enabled: false });
  check(turnedOff.status === 200 && turnedOff.body?.enabled === false, "receiving can be switched off", `HTTP ${turnedOff.status}`);
  const whileOff = await signedPost(offEvent, secret);
  const whileOffBody = await whileOff.json().catch(() => null);
  check(whileOff.status === 200 && whileOffBody?.ignored === "disabled",
    "a signed email arriving while it is off is not taken in", `HTTP ${whileOff.status} ${JSON.stringify(whileOffBody)}`);
  const offRows = ((await readSettings()).body?.recent ?? []).filter((entry) => entry.email_id === `${EMAIL_ID}_off`);
  check(offRows.length === 0, "and it wrote no ledger row", `${offRows.length} row(s)`);
} catch (error) {
  // A leg that threw is a failure like any other, and the restore below still has to run.
  if (error?.handled !== true) check(false, "the gate ran to the end without throwing", String(error?.message ?? error));
} finally {
  stub?.stop();
  step("putting the settings back");
  const restored = await writeSettings(restore).catch((error) => ({ status: 0, body: { error: String(error?.message ?? error) } }));
  check(restored.status === 200 && restored.body?.webhookSecretSet === false && restored.body?.apiKeySet === false,
    "the settings are restored and both secrets are cleared", `HTTP ${restored.status}`);
}

done();
