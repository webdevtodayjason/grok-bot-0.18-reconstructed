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
// --directory adds the MAIL-2 leg: every bot has an address of its own, agent<code>@<domain>, and
// the refusal order that goes with it. It stands up a STUB CONTROL PLANE of its own (the real
// cp/mail.mjs and cp/store.mjs over an in-memory database, so the minting under test is the
// minting that ships), asks the relay to sweep, and then proves three things through the public
// hook: a code address reaches the bot that holds it, an address nobody holds answers no_route and
// reaches nothing, and a name address still arrives carrying its retiring line. It needs the relay
// to have been started pointing at that stub:
//
//   CP_URL=http://127.0.0.1:7810 CP_RELAY_TOKEN=<32+ chars> node ui/server.mjs
//   node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub --directory --cp-port 7810
//
// If the relay is pointed somewhere else the sweep reaches nothing and this leg says so rather
// than passing on a directory nobody read.
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
// --send adds the MAIL-3 legs: a bot asks the relay to send, the RELAY decides the address it
// comes from, and no mail leaves without a row on the control plane saying it did. They ride
// --directory, because the claim goes to a control plane and the one this gate stands up is the
// real cp/mail.mjs over an in-memory store, so the row under test is the row that ships:
//
//   SAND_UI_MAIL_NO_SEND_FILE=/tmp/relay-state/mail-no-send.txt \
//   CP_URL=http://127.0.0.1:7810 CP_RELAY_TOKEN=<32+ chars> \
//   GROK_BOT_MAIL_API_BASE=http://127.0.0.1:7809 node ui/server.mjs
//   node scripts/verify-mail.mjs --url http://127.0.0.1:7787 --stub --send --directory --cp-port 7810
//
// THE CONTRACT THE SEND LEGS MEASURE, written down because MAIL-3 was built by three items in
// parallel and this is the seam between them:
//   relay          POST /mail/send, behind the box's own gateway bearer, body
//                  {agentId, to, subject, text, html?, inReplyTo?}; from, replyTo and headers.From
//                  are IGNORED, never honoured -- the From is the relay's to force. 401/403/400/
//                  429/503 in the order docs/MAIL.md section 6 writes down, and the answer names
//                  the recipient and Resend's id in plain words.
//   control plane  cp/mail.mjs exports createMailSends({ store }) answering
//                  openSend({slug, agentId, code, to}), closeSend(id, outcome, resendId) and
//                  listSends(slug).
//   relay again    GET /mail/settings gains `sends`, that workspace's own sent ledger, NEWEST
//                  FIRST like `recent`, carrying the subject the control plane deliberately does
//                  not hold.
//   console        gateway-adapter.js draws the row as "Sent an email to <to>" with an empty
//                  detail, under the outline name sendToUserToolCall, reading the recipient out of
//                  the proto args field `message` -- prefixed "not sent: " when nothing went.
// A tree missing any of those fails one named check rather than throwing somewhere unreadable.
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { OPERATOR_SLUG } from "../ui/tenant-registry.mjs";

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
    "--directory adds the per-bot address legs (MAIL-2). It needs the relay started with",
    "CP_URL pointing at --cp-port on this machine and CP_RELAY_TOKEN set to the same value this",
    "gate is given (--relay-token, or CP_RELAY_TOKEN in the environment).",
    "",
    "--send adds the MAIL-3 legs (the send route, the forced From, the log row, the refusals and",
    "the caps). It needs --stub and --directory, and --no-send-file (or SAND_UI_MAIL_NO_SEND_FILE)",
    "naming the state file the relay under test reads its no-send list from. --send-box adds the",
    "live half: a bot on the box, asked to send, and the row its conversation outline carries.",
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
// MAIL-2. The per-bot address legs, and where this gate's own stub control plane listens.
const DIRECTORY = process.argv.includes("--directory");
const CP_PORT = Number(flag("cp-port", process.env.MAIL_GATE_CP_PORT ?? "7810"));
const CP_TOKEN = String(flag("relay-token", process.env.CP_RELAY_TOKEN ?? ""));
// MAIL-3. The send legs, and the live half of them.
const SEND = process.argv.includes("--send");
const SEND_BOX = process.argv.includes("--send-box");
// How long the live half waits for a bot to decide to use the tool. It is a MODEL turn, so this is
// generous on purpose; the deterministic half of the same proof runs without it.
const SEND_BOX_WAIT_MS = Number(flag("send-box-wait", "150")) * 1000;
// The relay's no-send list. It is a state file the route reads per REQUEST, so this leg has to
// write it, and the path is named rather than guessed: export SAND_UI_MAIL_NO_SEND_FILE once and
// start the scratch relay with the same value.
const NO_SEND_FILE = String(flag("no-send-file", process.env.SAND_UI_MAIL_NO_SEND_FILE ?? ""));
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
// Every request this gate makes says who it is, so a line in the relay's log or a row in the send
// log that came from a gate is never mistaken for a customer's traffic.
const GATE_UA = "titanbot-gate/verify-mail";
const hit = (route, init = {}) => fetch(`${BASE}${route}`, {
  redirect: "manual", ...init, headers: { "user-agent": GATE_UA, ...(init.headers ?? {}) },
});
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
  // MAIL-3. The URLs alone cannot answer "was the From the relay forced the one that left", so
  // every call is recorded with its METHOD, its PARSED BODY and the answer this stub gave it. The
  // receive legs still read `seen`; the send legs read `calls`, because asserting a forced From
  // means reading the body the relay actually put on the wire.
  const calls = [];
  // MAIL-3 follow-up. A send the provider REJECTS still cost a call to the operator's account, so
  // the cap has to count it. Proving that needs a stub that says no, and only for sends: the
  // receive legs above read messages back through this same server.
  let rejectSend = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push(req.url);
      let body = null;
      try { body = raw.length > 0 ? JSON.parse(raw) : null; } catch { body = { unparsed: raw }; }
      // Resend answers a send with the id it gave the message, and that id is what the log row,
      // the workspace's own ledger and the sentence the bot says all have to carry.
      const isSend = String(req.method ?? "") === "POST" && String(req.url ?? "").split("?")[0] === "/emails";
      if (isSend && rejectSend != null) {
        calls.push({ method: String(req.method ?? ""), url: String(req.url ?? ""), body, answered: rejectSend.body, isSend, rejected: true });
        res.writeHead(rejectSend.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(rejectSend.body));
      }
      const answered = isSend
        ? { id: `em_stub_${randomBytes(8).toString("hex")}` }
        : (String(req.url ?? "").endsWith("/attachments") ? attachments : message);
      calls.push({ method: String(req.method ?? ""), url: String(req.url ?? ""), body, answered, isSend });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answered));
    });
  });
  return {
    seen,
    calls,
    /** Only the sends, so a leg can say "nothing reached Resend" and mean it. */
    sends() { return calls.filter((call) => call.isSend); },
    /** Make every send from here on come back refused, the way a real 422 reads. Null puts it back. */
    rejectSends(status = 0, body = null) { rejectSend = status > 0 ? { status, body } : null; },
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

// MAIL-3. The send legs claim their row on a control plane before Resend is called at all, and
// --directory is what stands one up. Said here rather than silently skipped, because a gate that
// runs fewer legs than you asked for and still says OK is a gate that has lied to you.
if (SEND && !DIRECTORY) {
  check(false, "--send needs --directory as well",
    "the send legs claim a row on a control plane before anything is sent, and --directory is what "
    + `stands one up. Re-run with --directory --cp-port ${CP_PORT}.`);
}

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
  // A NAME the roster does not share, and this is not fussiness. Two agents whose names come out
  // the same address is a supported state the card warns about (docs/MAIL.md section 2), and this
  // box holds "Chief of staff" and "Chief of Staff". Addressing one of those means the delivery is
  // correct and the assertion is wrong, so this gate used to go red for the roster's ordering
  // rather than for a fault -- measured on grok-bot-local-vm 2026-09-09, red one run and green the
  // next with nothing changed.
  const localpartOf = (row) => String(row?.address ?? "").split("@")[0].toLowerCase();
  const shared = new Set();
  const once = new Set();
  for (const row of roster) {
    const one = localpartOf(row);
    if (one.length === 0) continue;
    if (once.has(one)) shared.add(one); else once.add(one);
  }
  const target = roster.find((row) => localpartOf(row).length > 0 && !shared.has(localpartOf(row))) ?? roster[0] ?? firstAgent;
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
    // MAIL-2: this leg addresses the agent by NAME, and a name address at a domain the directory
    // covers is delivered with its retiring notice and written down as legacy_name. Both outcomes
    // are a delivery to the right agent, which is what this line is checking; which of the two it
    // is depends on whether this relay has a directory yet, and the --directory step below is what
    // measures that on purpose.
    check(["delivered", "legacy_name"].includes(row.outcome) && row.agentId === target.agentId,
      "and it names the agent it went to and says it arrived", JSON.stringify(row));
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

  // ---- the per-bot address directory (MAIL-2) ---------------------------------------------------
  if (DIRECTORY) {
    step("every bot has an address of its own");
    if (CP_TOKEN.length < 32) {
      check(false, "the relay credential is readable",
        "pass --relay-token, or set CP_RELAY_TOKEN, to the same value the relay under test was started with. "
        + "It is what opens the sweep route and the stub control plane below.");
    } else {
      const { openStore } = await import("../cp/store.mjs");
      const cpMail = await import("../cp/mail.mjs");
      const { createMailDirectory } = cpMail;
      const store = openStore({ file: ":memory:" });
      const directory = createMailDirectory({ store, domain: stubDomain });
      // MAIL-3. The send log, over the SAME store the directory uses, so the row the send legs
      // read is the row cp/mail.mjs writes in production. Named rather than guessed; a tree
      // without it fails one check that says so instead of throwing here.
      // cp/mail.mjs names these openSend/closeSend/listSends, and closeSend takes its arguments
      // one at a time. The three names this gate reads them by are kept as one small adapter, so
      // the legs below read as what they measure rather than as the control plane's spelling.
      const cpSends = typeof cpMail.createMailSends === "function" ? cpMail.createMailSends({ store }) : null;
      const sendLog = cpSends == null ? null : {
        open: (body) => cpSends.openSend(body ?? {}),
        close: (body) => cpSends.closeSend(body?.id, body?.outcome, body?.resendId, body?.detail),
        list: (slug, limit) => cpSends.listSends(slug, limit),
      };
      let cpClosed = false;
      const seen = { mint: [], directory: 0 };
      const cp = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          const url = new URL(req.url, "http://cp.invalid");
          const send = (status, body) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
          };
          if (String(req.headers.authorization ?? "") !== `Bearer ${CP_TOKEN}`) return send(401, { error: "unauthorized" });
          // The registry route answers an empty fleet: the relay under test keeps serving its own
          // workspace from its own environment, which is the whole compatibility story.
          if (url.pathname === "/v1/relay/tenants") return send(200, { tenants: [], skipped: [] });
          if (url.pathname === "/v1/relay/mail/directory") {
            seen.directory += 1;
            const slug = url.searchParams.get("slug");
            return send(200, directory.directory(slug && slug.length > 0 ? slug : null));
          }
          if (url.pathname === "/v1/relay/mail/mint") {
            let parsed; try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
            seen.mint.push(String(parsed.slug ?? ""));
            return send(200, directory.mint(parsed.slug, parsed.agents));
          }
          // MAIL-3. Claim before Resend, close after it. These two are the reason a send that was
          // never logged is a send that never happened, so this stub runs the real cp/mail.mjs
          // rather than a copy of what it is supposed to do.
          if (url.pathname === "/v1/relay/mail/send/open" || url.pathname === "/v1/relay/mail/send/close") {
            if (sendLog == null) return send(503, { error: "no_send_log" });
            let parsed; try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
            const answer = url.pathname.endsWith("/open") ? sendLog.open(parsed) : sendLog.close(parsed);
            const status = answer?.error === "rate_limited" ? 429 : answer?.error != null ? 400 : 200;
            return send(status, answer);
          }
          return send(404, { error: "not_found" });
        });
      });
      try {
        await new Promise((resolve, reject) => { cp.once("error", reject); cp.listen(CP_PORT, "127.0.0.1", resolve); });
        const swept = await hit("/mail/sweep", { method: "POST", headers: { authorization: `Bearer ${CP_TOKEN}` } });
        const sweptBody = await swept.json().catch(() => null);
        check(swept.status === 200 && seen.mint.length > 0,
          "the relay swept its workspaces against this gate's control plane",
          `HTTP ${swept.status} ${JSON.stringify(sweptBody)}; if nothing was minted the relay is pointed at a `
          + `different control plane. Start it with CP_URL=http://127.0.0.1:${CP_PORT} and the same CP_RELAY_TOKEN.`);

        const rows = store.listMailAddresses().filter((row) => row.state === "active");
        check(rows.length > 0, "and every bot on it now holds a six digit address",
          rows.map((row) => `${row.agentName}=${row.address}`).join(" "));
        for (const row of rows) {
          check(/^agent\d{6}@/.test(row.address), "no address carries a name", row.address);
        }
        if (rows.length > 0) {
          const mine = rows[0];
          const codeId = `${EMAIL_ID}_code`;
          const toCode = JSON.stringify({
            type: "email.received", created_at: new Date().toISOString(),
            data: { email_id: codeId, to: [mine.address], from: "gate@example.invalid", subject: "verify-mail to a code address" },
          });
          const delivered = await signedPost(toCode, secret);
          const deliveredBody = await delivered.json().catch(() => null);
          check(delivered.status === 200 && deliveredBody?.delivered?.agentId === mine.agentId,
            `a message to ${mine.address} reaches ${mine.agentName || "that bot"}`,
            `HTTP ${delivered.status} ${JSON.stringify(deliveredBody)}`);

          // The leak that closes. An address nobody holds is nobody's, and the catch-all -- which
          // on a relay claiming this domain is its own Titan -- is never reached.
          const nobodyId = `${EMAIL_ID}_nobody`;
          const toNobody = JSON.stringify({
            type: "email.received", created_at: new Date().toISOString(),
            data: { email_id: nobodyId, to: [`agent999999@${stubDomain}`], from: "gate@example.invalid", subject: "verify-mail to nobody" },
          });
          const refused = await signedPost(toNobody, secret);
          const refusedBody = await refused.json().catch(() => null);
          check(refused.status === 200 && refusedBody?.ignored === "no_route",
            "an address nobody holds answers no_route and reaches no agent at all",
            `HTTP ${refused.status} ${JSON.stringify(refusedBody)}`);

          // A name address still arrives, and the ledger says which kind of arrival it was.
          const legacyId = `${EMAIL_ID}_legacy`;
          const toName = JSON.stringify({
            type: "email.received", created_at: new Date().toISOString(),
            data: { email_id: legacyId, to: [`${String(target.address).split("@")[0]}@${stubDomain}`], from: "gate@example.invalid", subject: "verify-mail to a name" },
          });
          const legacy = await signedPost(toName, secret);
          const legacyBody = await legacy.json().catch(() => null);
          check(legacy.status === 200 && legacyBody?.delivered?.agentId === target.agentId,
            "a name address still arrives while it is being retired",
            `HTTP ${legacy.status} ${JSON.stringify(legacyBody)}`);
          const ledger = (await readSettings()).body?.recent ?? [];
          const kindOf = (id) => ledger.find((row) => row.email_id === id)?.outcome ?? "no row";
          check(kindOf(codeId) === "delivered", "the ledger calls the code address delivered", kindOf(codeId));
          check(kindOf(nobodyId) === "no_route", "and the unknown address no_route", kindOf(nobodyId));
          check(kindOf(legacyId) === "legacy_name", "and the name address legacy_name, which is what dates it", kindOf(legacyId));
        }

        // ---- sending, and the From nobody outside this relay chooses (MAIL-3) ------------------
        //
        // The whole of MAIL-3 in one section: a bot asks the relay to send, the RELAY decides the
        // address it comes from, and no mail leaves without a row on the control plane saying it
        // did. It rides these directory legs deliberately -- the claim goes to a control plane, and
        // the one this gate stands up is the real cp/mail.mjs over an in-memory store, so the row
        // under test is the row that ships.
        if (SEND) {
          step("a bot sends, and the relay decides what address it comes from");
          const OWN = String(flag("slug", OPERATOR_SLUG));
          const ours = rows.filter((entry) => entry.tenant === OWN);
          const mine = ours[0] ?? null;
          // A second bot for the cap leg, so thirty sends by one bot cannot poison the refusals
          // measured above it: every one of those is measured on a bot with its hour intact.
          const capBot = ours[1] ?? mine;
          if (sendLog == null) {
            check(false, "cp/mail.mjs holds the send log this gate claims a row through",
              "expected createMailSends({ store }) answering openSend({slug, agentId, code, to}), "
              + "closeSend(id, outcome, resendId) and listSends(slug). Without it the control plane "
              + "half of MAIL-3 is not in this tree, so no send leg below can run.");
          } else if (mine == null) {
            check(false, `the directory holds an address for a bot in ${OWN}`,
              rows.map((entry) => `${entry.tenant}/${entry.agentName}`).join(" ") || "no active rows at all");
          } else {
            const RECIPIENT = "gate-recipient@example.invalid";
            const IMPOSTOR = "president@example.invalid";
            const SUBJECT = "verify-mail send leg";
            const good = (agentId = mine.agentId) => ({ agentId, to: RECIPIENT, subject: SUBJECT, text: `sent by ${BODY_LINE}` });
            const sendAs = (body, bearer = TOKEN) => hit("/mail/send", {
              method: "POST",
              headers: { ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }), "content-type": "application/json" },
              body: JSON.stringify(body),
            });

            // The send itself. Every field a caller could use to name its own From is supplied here
            // on purpose and none of them may survive: a caller that could set the From could send
            // as any bot at this domain, which is the whole reason the key never left the relay.
            const beforeSend = stub.sends().length;
            const reply = await sendAs({
              ...good(), from: `Someone Else <${IMPOSTOR}>`, replyTo: IMPOSTOR,
              headers: { From: `Someone Else <${IMPOSTOR}>` },
            });
            const replyBody = await reply.json().catch(() => null);
            const sent = stub.sends();
            const wire = sent[sent.length - 1] ?? null;
            const onWire = wire?.body ?? {};
            const wantFrom = `"${mine.agentName} (${OWN})" <${mine.address}>`;
            check(reply.status === 200 && sent.length === beforeSend + 1
              && String(onWire.from ?? "") === wantFrom
              && String(onWire.reply_to ?? onWire.replyTo ?? "") === mine.address
              && !JSON.stringify(onWire).includes(IMPOSTOR),
              "the From and the Reply-To are the bot's own address, and the caller's never reached Resend",
              `HTTP ${reply.status}; Resend saw from=${JSON.stringify(onWire.from)} `
              + `reply_to=${JSON.stringify(onWire.reply_to ?? onWire.replyTo)}; wanted ${wantFrom}`);

            const resendId = String(wire?.answered?.id ?? "");
            const logged = sendLog.list(OWN, 50) ?? [];
            const idOf = (entry) => String(entry?.resendId ?? entry?.resend_id ?? "");
            const toOf = (entry) => String(entry?.to ?? entry?.toAddr ?? entry?.to_addr ?? "");
            const logRow = resendId.length === 0 ? null : logged.find((entry) => idOf(entry) === resendId) ?? null;
            check(logRow != null && toOf(logRow) === RECIPIENT && ["sent", "ok", "delivered"].includes(String(logRow.outcome ?? "")),
              "the control plane holds one row for it, carrying Resend's own id",
              `resend id ${resendId || "none"}; last rows ${JSON.stringify(logged.slice(-2))}`);
            check(!JSON.stringify(logged).includes(SUBJECT),
              "and no subject is on the control plane's row -- that lives on the workspace's own ledger",
              "the super admin sees who wrote to whom and whether it went, never what it said");

            const answer = JSON.stringify(replyBody ?? {});
            check(reply.status === 200 && resendId.length > 0 && answer.includes(resendId) && answer.includes(RECIPIENT),
              "and the bot is answered in plain words, naming the recipient and the message id",
              answer.slice(0, 240));

            // ---- the refusals, in the order that makes them safe --------------------------------
            step("the refusals, and that not one of them reaches Resend");
            const refused = async (label, want, body, bearer = TOKEN) => {
              const before = stub.sends().length;
              const response = await sendAs(body, bearer);
              const text = await response.text().catch(() => "");
              const leaked = stub.sends().length - before;
              check(response.status === want && leaked === 0, label,
                `HTTP ${response.status} (wanted ${want}), ${leaked} reached Resend: ${text.slice(0, 140)}`);
              return text;
            };

            await refused("no bearer at all is 401", 401, good(), null);
            await refused("a bearer no workspace holds is 401", 401, good(), `gate_${randomBytes(16).toString("hex")}`);

            // One directory lookup refuses all three of these, and all three answer the SAME
            // sentence: a caller must learn nothing at all about a workspace that is not its own.
            const foreignAgent = `gate-foreign-${randomBytes(4).toString("hex")}`;
            const goneAgent = `gate-retired-${randomBytes(4).toString("hex")}`;
            store.mintMailCode({ tenant: "gate-elsewhere", agentId: foreignAgent, agentName: "Somebody Else", domain: stubDomain });
            const gone = store.mintMailCode({ tenant: OWN, agentId: goneAgent, agentName: "Gone", domain: stubDomain });
            if (gone?.code != null) store.retireMailAddress(gone.code);
            await hit("/mail/sweep", { method: "POST", headers: { authorization: `Bearer ${CP_TOKEN}` } });

            const noAddress = await refused("a bot with no address is 403", 403, good(`gate-nobody-${randomBytes(4).toString("hex")}`));
            const foreign = await refused("another workspace's bot is 403", 403, good(foreignAgent));
            const retired = await refused("a retired address is 403", 403, good(goneAgent));
            check(noAddress === foreign && foreign === retired,
              "and all three say the same thing, so nothing is learned about a workspace that is not yours",
              [noAddress, foreign, retired].map((one) => one.slice(0, 70)).join(" | "));

            await refused("an attachments field is refused by name, because it is not this wave", 400,
              { ...good(), attachments: [{ filename: "note.txt", content: "aGk=" }] });

            // ---- the workspace's own ledger ----------------------------------------------------
            step("the workspace's own sent ledger, the only place the subject is");
            // A second send, so the order below is measured on two rows rather than assumed from
            // one. A one-row list is in order whatever the relay does with it.
            await sendAs({ ...good(), to: "gate-second@example.invalid", subject: `${SUBJECT} (the second)` });
            const settings = await readSettings();
            const sends = Array.isArray(settings.body?.sends) ? settings.body.sends : null;
            check(sends != null && sends.some((row) => String(row.to ?? "") === RECIPIENT && String(row.subject ?? "") === SUBJECT),
              "the send is on GET /mail/settings.sends with its subject, where only this workspace reads it",
              JSON.stringify((sends ?? []).slice(0, 2)));
            // Newest first, the same way `recent` is, because the card paints the array in the
            // order the relay gave it and the operator reads the top row as the last thing that
            // happened. Measured in a browser on this Mac before this line existed: the table drew
            // oldest first and read as a week-old send being the newest.
            const ordered = (sends ?? []).map((row) => String(row.at ?? ""));
            check(sends != null && ordered.length > 1 && ordered.every((at, i) => i === 0 || ordered[i - 1] >= at)
              && String(sends[0].to ?? "") === "gate-second@example.invalid",
              "and it is newest first, the same order the received list is in",
              `${ordered.length} row(s): ${ordered.slice(0, 3).join(" then ")}`);

            // ---- what the console draws for it -------------------------------------------------
            // The shipped toolRowText, RUN rather than pattern-matched: a copy of it in this file
            // would go on passing after the adapter changed. FEEDBACK-1 pinned its row the same way.
            step("what a person sees when a bot sends");
            const drawn = (() => {
              try {
                const source = readFileSync(new URL("../ui/machine-room/gateway-adapter.js", import.meta.url), "utf8");
                const from = source.indexOf("  const PROBLEM_REPORT_TOOL_CALL");
                const to = source.indexOf("  const messageKey =");
                if (from < 0 || to <= from) return { error: "the tool-row block could not be found in gateway-adapter.js" };
                const made = new Function(`${source.slice(from, to)}\nreturn { toolRowText, TOOL_LABELS };`)();
                // The summary is the proto args as the outline serialises them, and the field the
                // tool fills is SendToUserArgs.message -- one string, the recipient, with the
                // refusal marker in front of it when nothing went. Both halves are drawn here,
                // because a refused send that read "Sent an email to ..." on a customer's screen is
                // the one failure this row exists to prevent.
                return {
                  row: made.toolRowText({ name: "sendToUserToolCall", summary: JSON.stringify({ message: RECIPIENT }), status: "done" }),
                  failedRow: made.toolRowText({ name: "sendToUserToolCall", summary: JSON.stringify({ message: `not sent: ${RECIPIENT}` }), status: "done" }),
                  labelled: Object.prototype.hasOwnProperty.call(made.TOOL_LABELS, "sendToUserToolCall"),
                };
              } catch (error) { return { error: String(error?.message ?? error) }; }
            })();
            check(drawn.error == null && drawn.labelled === true
              && String(drawn.row?.text ?? "") === `Sent an email to ${RECIPIENT}`
              && String(drawn.row?.detail ?? "x") === "",
              'the row reads "Sent an email to ..." with no tool name and no expandable payload',
              drawn.error ?? `${JSON.stringify(drawn.row)}, labelled ${drawn.labelled}`);
            check(drawn.error == null
              && String(drawn.failedRow?.text ?? "") === `Tried to email ${RECIPIENT} · it did not send`
              && String(drawn.failedRow?.detail ?? "x") === "",
              "and a send the relay refused says so rather than reading as one that went",
              drawn.error ?? JSON.stringify(drawn.failedRow));

            // ---- the caps ----------------------------------------------------------------------
            step("the caps, which the control plane counts and a box cannot reset by restarting");
            const cap = Number(store.getSetting("mail.send.hourlyPerAgent", "30")) || 30;
            let accepted = capBot.agentId === mine.agentId ? 1 : 0;
            let capRefusal = null;
            while (accepted < cap && capRefusal == null) {
              const response = await sendAs(good(capBot.agentId));
              const text = await response.text().catch(() => "");
              if (response.status === 200) accepted += 1;
              else capRefusal = { status: response.status, text };
            }
            if (capRefusal == null) {
              const over = await sendAs(good(capBot.agentId));
              capRefusal = { status: over.status, text: await over.text().catch(() => "") };
            }
            check(accepted === cap && capRefusal.status === 429 && capRefusal.text.includes(String(cap)),
              `the send after ${cap} in an hour is refused, and the refusal names ${cap}`,
              `${accepted} accepted, then HTTP ${capRefusal.status} ${capRefusal.text.slice(0, 160)}`);

            // ---- a send the provider refuses, which still counts ---------------------------------
            //
            // The hole this leg exists to close: the counts behind the cap once took `sending` and
            // `sent` and nothing else, so a bot whose every send was rejected never ran out of
            // hour and could keep the relay calling the operator's shared account for ever. Sixty
            // failing sends from one bot made sixty calls and no refusal. The cap is lowered for
            // the length of this leg so it costs four calls rather than thirty-one.
            step("a send the mail service refuses still spends the bot's hour");
            const failBot = ours[2] ?? capBot;
            const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
            const beforeFail = store.agentMailSendWindow(OWN, failBot.agentId, hourAgo()).count;
            const capWas = store.getSetting("mail.send.hourlyPerAgent", "");
            store.setSetting("mail.send.hourlyPerAgent", String(beforeFail + 3));
            stub.rejectSends(422, {
              statusCode: 422, name: "validation_error",
              message: "The example.invalid domain is not verified. Please verify at resend.com/domains",
            });
            try {
              const statuses = [];
              const words = [];
              for (let n = 0; n < 4; n += 1) {
                const response = await sendAs(good(failBot.agentId));
                statuses.push(response.status);
                words.push(String((await response.json().catch(() => null))?.message ?? ""));
              }
              check(statuses.join(",") === "502,502,502,429",
                "three refused sends, and the fourth is over the cap rather than a fourth call out",
                statuses.join(","));
              // What the bot reads out to the person. The provider's own words belong on the row.
              const leaked = words.slice(0, 3).filter((word) => /HTTP |[{}]|resend/i.test(word));
              check(leaked.length === 0 && words[0].includes("nothing was sent"),
                "and what the bot is handed is one plain sentence with no status code, no JSON and no vendor in it",
                leaked[0] ?? words[0]);
              const rowsAfter = sendLog.list(OWN, 200).filter((row) => row.agentId === failBot.agentId);
              check(rowsAfter.filter((row) => row.outcome === "failed").length >= 3,
                "the three that failed are on the record as failed",
                rowsAfter.map((row) => row.outcome).join(","));
            } finally {
              stub.rejectSends(0);
              store.setSetting("mail.send.hourlyPerAgent", capWas);
            }

            // ---- switched off for a workspace --------------------------------------------------
            step("switched off for a workspace, and a control plane that cannot be reached");
            if (NO_SEND_FILE.length === 0) {
              check(false, "the relay's no-send list is writable by this gate",
                "pass --no-send-file, or set SAND_UI_MAIL_NO_SEND_FILE to the path the scratch relay "
                + "was started with. The route reads it per request, and this leg has to write it.");
            } else {
              writeFileSync(NO_SEND_FILE, `${OWN}\n`, { mode: 0o600 });
              try {
                await refused("a workspace on the no-send list is refused before anything is claimed or sent", 403, good());
              } finally { writeFileSync(NO_SEND_FILE, "", { mode: 0o600 }); }
            }

            // ---- the live half, behind its own flag --------------------------------------------
            // A bot on the box actually asked to send, and the row its conversation outline
            // carries. It is a MODEL turn -- the bot has to decide to use the tool -- so it is slow
            // and it is not deterministic, and a gate that goes red for a reason that is not a
            // fault is a gate nobody reads. The deterministic half of the same proof is above.
            if (SEND_BOX) {
              step("a bot on the box, asked to send, and the row its outline carries");
              const api = (method, args) => hit(`/api/${method}`, {
                method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(args),
              }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
              const sweep = () => hit("/mail/sweep", { method: "POST", headers: { authorization: `Bearer ${CP_TOKEN}` } }).catch(() => null);
              let scratch = "";
              try {
                const made = await api("createAgent", {
                  name: `gate-mail-${randomBytes(3).toString("hex")}`,
                  description: "verify-mail send leg. Safe to delete.", origin: "user", isKickstartRequested: false,
                });
                scratch = String(made.body?.id ?? made.body?.agentId ?? "");
                check(scratch.length > 0, "a scratch bot to send from", JSON.stringify(made.body ?? null).slice(0, 160));
                if (scratch.length > 0) {
                  // It needs an address before it can send, and the sweep is what gives it one.
                  await sweep();
                  await api("sendPrompt", {
                    agentId: scratch,
                    prompt: `Send an email to ${RECIPIENT}. The subject is "${SUBJECT}" and the body is one `
                      + "line naming the address it came from. Send it now, then tell me what happened.",
                    clientNonce: `verify-mail-${randomBytes(6).toString("hex")}`,
                  });
                  const deadline = Date.now() + SEND_BOX_WAIT_MS;
                  let row = null;
                  while (Date.now() < deadline && row == null) {
                    await new Promise((resolve) => { setTimeout(resolve, 3000); });
                    const outline = await api("getConversationOutline", { id: scratch });
                    const items = Array.isArray(outline.body) ? outline.body
                      : Array.isArray(outline.body?.items) ? outline.body.items : [];
                    row = items.find((item) => String(item?.name ?? "") === "sendToUserToolCall") ?? null;
                  }
                  check(row != null && JSON.stringify(row).includes(RECIPIENT),
                    "the send is one outline row named sendToUserToolCall, carrying the recipient and nothing else",
                    row == null ? `no such row within ${Math.round(SEND_BOX_WAIT_MS / 1000)}s`
                      : JSON.stringify(row).slice(0, 200));
                  check(row == null || !/subject|verify-mail send leg/i.test(JSON.stringify(row)),
                    "and no subject and no body is in it, because that row is drawn on a customer's screen",
                    JSON.stringify(row ?? null).slice(0, 200));
                }
              } finally {
                // The roster this gate found is the roster it leaves. A scratch bot left behind
                // holds a routable address for ever, which is what MAIL-2d was filed for.
                if (scratch.length > 0) {
                  await api("deleteAgent", { id: scratch }).catch(() => {});
                  await sweep();
                }
              }
            }

            // ---- and the one refusal that must survive everything else --------------------------
            // Last, because it takes the control plane away and nothing above can run without one.
            const beforeDown = stub.sends().length;
            cp.closeAllConnections?.();
            cp.close();
            cpClosed = true;
            const down = await sendAs(good());
            const downText = await down.text().catch(() => "");
            check(down.status === 503 && stub.sends().length === beforeDown,
              "with the control plane unreachable nothing is sent, because an unlogged send is worse than an unsent one",
              `HTTP ${down.status} ${downText.slice(0, 160)}`);
          }
        }
      } catch (error) {
        check(false, "the address legs ran to the end", String(error?.message ?? error));
      } finally {
        if (!cpClosed) cp.close();
        store.close();
      }
    }
  }

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
