// MAIL-3. The bot's own send: the relay hop, the tool, and the four facts that decide whether the
// tool exists at all.
//
// Jason, 2026-09-09 12:15: "I didn't realize that the bots couldn't send mail yet." He asked his
// Titan for a test mail and Titan answered that sending was not wired up, which was true.
//
// Each case here is a way this could have gone wrong in a way nobody would have noticed until a
// customer's mail went out under somebody else's name:
//
//   - the row's OUTLINE NAME. The console keys the chip off it, and the row survives only because
//     that name misses the NOT_A_RECEIPT filter. A communicate-wrapped tool would have been named
//     communicateUpdateToolCall and dropped one function before the renderer, and a mail leaving
//     the workspace would have left no mark on the person's screen at all.
//   - the PARSE. Both the relay's address and the bearer come out of one string. Reading
//     process.env.SAND_GATEWAY_TOKEN instead would work on a tenant box and quietly produce a
//     token the registry has never seen on a loopback one, where the failure reads as "the relay
//     refused" rather than "there is no relay here".
//   - the REFUSAL. A relay that says no must reach the model as its own sentence. A tool that
//     turned a refusal into anything a model could read as a send is the exact failure the whole
//     wave exists to stop.
//   - the ARGS. What rides the outline is drawn on a customer's screen. The recipient may be
//     there; the subject and the body may not, whatever the model typed.
//   - the WITHHOLD. A tool offered on a box the relay has not switched on is a bot holding a
//     capability its own standing facts deny, and a 27th tool schema on a fleet measured at 26.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".send-email-test-"));
const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const client = await load("source/host/extensions/mail/relay-send-client.ts", "relay-send-client");
const tool = await load("source/host/runner/tools/send-email-tool.ts", "send-email-tool");
const outline = await load("source/host/runner/conversation-outline.ts", "conversation-outline");
const toolset = await load("source/host/runner/tools/turn-toolset.ts", "turn-toolset");
const contextModule = await load("source/packages/context/core.ts", "context-core");
const ctx = () => contextModule.createContext().withName("send-email-test");

// The two strings this product actually runs on, both read off a live box rather than invented.
// MEASURED 2026-09-09 17:52Z inside the runner process on grok-bot-local-vm (pid 448,
// /home/box/sand-host/host-main.cjs): the variable is present there, the path is /runtime/<token>,
// and the token is byte-equal to SAND_GATEWAY_TOKEN.
const LOCAL_BASE = "http://host.docker.internal:7787/runtime/tok-local-64";
const R750_BASE = "http://titanbot-relay:7777/runtime/tok-r750-64";
const DEFAULT_S3_BASE =
  "https://public-asphr-vm-daemon-bucket.s3.us-east-1.amazonaws.com/sand-host-bundle";

const freshRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "send-email-"));
  roots.push(root);
  return root;
};

const AGENT = "agent-under-test";
const OWN = { code: "247758", address: "agent247758@myagents.email" };

const args = (extra = {}) => ({
  to: "jane@client.example",
  subject: "September invoice",
  text: "Thanks Jane, that is received.",
  ...extra,
});

/** The runner's contract, in the smallest shape the tool uses. Everything emitted is kept. */
function handler() {
  const seen = { initial: null, completed: null };
  return {
    seen,
    executeToolCall: async (context, initial, id, run, merge) => {
      seen.initial = initial;
      const result = await run(context);
      seen.completed = merge(result);
      return result;
    },
  };
}

const runTool = async (built, callArgs, toolCallId = "call-1") => {
  const stream = (async function* () { yield JSON.stringify(callArgs); })();
  const seat = handler();
  const result = await built.execute(ctx(), seat, stream, { toolCallId });
  return { result, seen: seat.seen, built };
};

const deps = (overrides = {}) => {
  const posted = [];
  return {
    posted,
    dependencies: {
      getAgentId: () => AGENT,
      readMail: (agentId) => (agentId === AGENT ? OWN : null),
      resolveRelay: () => client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: R750_BASE }),
      post: async (target, body, timeoutMs) => {
        posted.push({ target, body, timeoutMs });
        return { sent: true, id: "resend-abc123", message: "queued", status: 200 };
      },
      ...overrides,
    },
  };
};

// ---- the parse -----------------------------------------------------------------------------

test("MAIL-3: the relay's address and the box's bearer both come out of the one bundle base", () => {
  assert.deepEqual(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: R750_BASE }), {
    base: "http://titanbot-relay:7777", token: "tok-r750-64",
  });
  assert.deepEqual(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: LOCAL_BASE }), {
    base: "http://host.docker.internal:7787", token: "tok-local-64",
  });
  // A trailing slash is the same relay, not a different one.
  assert.deepEqual(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: `${R750_BASE}/` }), {
    base: "http://titanbot-relay:7777", token: "tok-r750-64",
  });
});

test("MAIL-3: a box with no relay in front of it resolves nothing, which is how the tool disappears", () => {
  assert.equal(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: DEFAULT_S3_BASE }), undefined,
    "the default bucket is not a relay: an ordinary install must not grow a send route");
  assert.equal(client.resolveRelaySend({}), undefined);
  assert.equal(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: "   " }), undefined);
  assert.equal(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: "not a url" }), undefined);
  assert.equal(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: "http://relay:7777/runtime/" }), undefined,
    "an empty token segment is not a credential");
  assert.equal(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: "http://relay:7777/runtime/a/b" }), undefined,
    "a deeper path is not the shape the relay serves");
  assert.equal(client.resolveRelaySend({ SAND_HOST_BUNDLE_S3_BASE_URL: "file:///runtime/tok" }), undefined);
});

// ---- the hop -------------------------------------------------------------------------------

test("MAIL-3: the send goes to the parsed base, with the parsed token, and no from anywhere", async () => {
  const calls = [];
  const answer = await client.postMailSend(
    { base: "http://titanbot-relay:7777", token: "tok-r750-64" },
    { agentId: AGENT, to: "jane@client.example", subject: "s", text: "t", idempotencyKey: `${AGENT}:call-1` },
    5000,
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sent: true, id: "resend-abc123", message: "queued" }), { status: 200 });
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://titanbot-relay:7777/mail/send");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok-r750-64");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.agentId, AGENT);
  assert.equal(body.idempotencyKey, `${AGENT}:call-1`);
  for (const forbidden of ["from", "replyTo", "reply_to", "headers", "apiKey"]) {
    assert.equal(forbidden in body, false, `${forbidden} must never be a field on a send`);
  }
  assert.deepEqual(answer, { sent: true, status: 200, message: "queued", id: "resend-abc123" });
});

test("MAIL-3: a relay that cannot be reached is a refusal with a sentence, never a thrown turn", async () => {
  const answer = await client.postMailSend(
    { base: "http://titanbot-relay:7777", token: "t" },
    { agentId: AGENT, to: "a@b.example", subject: "s", text: "t", idempotencyKey: "k" },
    5000,
    async () => { throw new Error("connect ECONNREFUSED"); },
  );
  assert.equal(answer.sent, false);
  assert.equal(answer.status, 0);
  assert.match(answer.message, /could not be reached/);
});

test("MAIL-3: only the relay's own word makes a send, and its refusal travels verbatim", async () => {
  const cap = await client.postMailSend(
    { base: "http://r:1", token: "t" },
    { agentId: AGENT, to: "a@b.example", subject: "s", text: "t", idempotencyKey: "k" },
    5000,
    async () => new Response(JSON.stringify({
      sent: false,
      message: "that is 30 mails this hour, which is the limit for one bot; the next one can go at 14:00 UTC",
    }), { status: 429 }),
  );
  assert.equal(cap.sent, false);
  assert.equal(cap.message, "that is 30 mails this hour, which is the limit for one bot; the next one can go at 14:00 UTC");
  assert.equal("id" in cap, false, "a refusal carries no provider id");

  // A 200 that does not say `sent` is not a send. This is the shape a half-written route answers
  // with, and reading it as a success is how a product starts claiming mail it never sent.
  const quiet = await client.postMailSend(
    { base: "http://r:1", token: "t" },
    { agentId: AGENT, to: "a@b.example", subject: "s", text: "t", idempotencyKey: "k" },
    5000,
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  assert.equal(quiet.sent, false);

  const garbage = await client.postMailSend(
    { base: "http://r:1", token: "t" },
    { agentId: AGENT, to: "a@b.example", subject: "s", text: "t", idempotencyKey: "k" },
    5000,
    async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
  );
  assert.equal(garbage.sent, false);
  assert.match(garbage.message, /502/);
  assert.doesNotMatch(garbage.message, /</, "a page of HTML is not a sentence a bot may repeat");
});

// ---- the tool ------------------------------------------------------------------------------

test("MAIL-3: the row's outline name is one the console can see and label", () => {
  const call = { tool: { case: tool.SEND_EMAIL_OUTLINE_NAME, value: { args: undefined } } };
  assert.equal(outline.getOutlineToolCallName(call), "sendToUserToolCall");
  // The filter the console drops non-receipt rows with. A communicate-wrapped tool would have been
  // named communicateUpdateToolCall and thrown away one function before the renderer.
  const NOT_A_RECEIPT = /communicate|update_state|todo|send.?to.?agent|react.?to.?message|sleep|wait|getmcptools/i;
  assert.equal(NOT_A_RECEIPT.test(tool.SEND_EMAIL_OUTLINE_NAME), false,
    "sendToUserToolCall must miss this filter or a sent mail leaves no chip at all");
  assert.equal(NOT_A_RECEIPT.test("communicateUpdateToolCall"), true, "which is what the template would have produced");
  assert.equal(NOT_A_RECEIPT.test("sendToAgentToolCall"), true, "and the case it is easily mistaken for");
});

test("MAIL-3: a send the relay confirmed reaches the model as a send, and claims nothing beyond it", async () => {
  const d = deps();
  const built = tool.createSendEmailTool(d.dependencies);
  const { result } = await runTool(built, args());
  assert.equal(result.result.case, "success");
  assert.equal(d.posted.length, 1);
  assert.equal(d.posted[0].target.base, "http://titanbot-relay:7777");
  assert.equal(d.posted[0].target.token, "tok-r750-64");
  assert.equal(d.posted[0].body.to, "jane@client.example");
  assert.equal(d.posted[0].body.subject, "September invoice");
  assert.equal(d.posted[0].body.text, "Thanks Jane, that is received.");

  const said = (await built.render(ctx(), result)).text ?? (await built.render(ctx(), result));
  const sentence = typeof said === "string" ? said : JSON.stringify(said);
  assert.match(sentence, /jane@client\.example/, "it names who it went to");
  assert.match(sentence, /agent247758@myagents\.email/, "and the address it went from");
  assert.match(sentence, /resend-abc123/, "and the provider's id, so the operator can find it");
  assert.match(sentence, /not the same as read|do not promise it arrived/i,
    "accepted is not delivered, and the model has to be told so");
});

test("MAIL-3: the optional fields travel only when the model supplied them", async () => {
  const d = deps();
  const built = tool.createSendEmailTool(d.dependencies);
  await runTool(built, args());
  assert.equal("html" in d.posted[0].body, false);
  assert.equal("inReplyTo" in d.posted[0].body, false);

  await runTool(built, args({ html: "<p>hi</p>", in_reply_to: "<abc@client.example>" }), "call-2");
  assert.equal(d.posted[1].body.html, "<p>hi</p>");
  assert.equal(d.posted[1].body.inReplyTo, "<abc@client.example>",
    "the thread header is what keeps a reply in the same thread");
});

test("MAIL-3: the idempotency key is per call and not per attempt, so a retry cannot send twice", async () => {
  const d = deps();
  const built = tool.createSendEmailTool(d.dependencies);
  await runTool(built, args(), "call-7");
  await runTool(built, args(), "call-7");
  await runTool(built, args(), "call-8");
  assert.equal(d.posted[0].body.idempotencyKey, `${AGENT}:call-7`);
  assert.equal(d.posted[1].body.idempotencyKey, `${AGENT}:call-7`,
    "the same tool call retried is the same key, which is what Resend's window dedupes on");
  assert.equal(d.posted[2].body.idempotencyKey, `${AGENT}:call-8`);
});

test("MAIL-3: there is no from parameter, and one supplied anyway never reaches the relay", async () => {
  const schema = tool.sendEmailParameters.shape;
  for (const forbidden of ["from", "reply_to", "replyTo", "headers", "cc", "bcc"]) {
    assert.equal(forbidden in schema, false, `${forbidden} must not be a parameter of this tool`);
  }
  const d = deps();
  const built = tool.createSendEmailTool(d.dependencies);
  await runTool(built, args({ from: "titan@titanium.bot", reply_to: "somebody@else.example", cc: "x@y.example" }));
  const body = JSON.stringify(d.posted[0].body);
  assert.doesNotMatch(body, /titan@titanium\.bot/, "a supplied from is dropped on the floor, not forwarded");
  assert.doesNotMatch(body, /somebody@else\.example/);
  assert.doesNotMatch(body, /x@y\.example/);
});

test("MAIL-3: the outline args carry the recipient and neither the subject nor the body", async () => {
  const d = deps();
  const built = tool.createSendEmailTool(d.dependencies);
  const { seen } = await runTool(built, args({
    subject: "SECRET-SUBJECT-nobody-may-see",
    text: "SECRET-BODY-nobody-may-see",
  }));
  for (const call of [seen.initial, seen.completed]) {
    const json = JSON.stringify(call.tool.value.args.toJson());
    assert.match(json, /jane@client\.example/, "the recipient is the row's whole point");
    assert.doesNotMatch(json, /SECRET-SUBJECT/, "the subject is drawn on a customer's screen if it is here");
    assert.doesNotMatch(json, /SECRET-BODY/);
    // One field, one string. Anything else in this proto is a second place a body could hide.
    assert.deepEqual(Object.keys(call.tool.value.args.toJson()), ["message"]);
  }
  assert.equal(seen.completed.tool.value.args.message, "jane@client.example",
    "a confirmed send carries the bare address, which is what the console draws");
});

test("MAIL-3: a refusal is an error result carrying the relay's sentence, and marks the row not sent", async () => {
  const refused = "sending is switched off for this workspace";
  const d = deps({
    post: async () => ({ sent: false, status: 403, message: refused }),
  });
  const built = tool.createSendEmailTool(d.dependencies);
  const { result, seen } = await runTool(built, args());
  assert.equal(result.result.case, "error");
  assert.equal(result.result.value.error, refused, "the relay's own words, not a paraphrase");
  const rendered = await built.render(ctx(), result);
  const sentence = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  assert.match(sentence, /was not sent/);
  assert.doesNotMatch(sentence, /\bSent to\b/, "nothing here may read as a send that happened");
  // The console has no result to read on this proto case, so the outcome rides the one string it
  // does read. Without the marker the chip would have said "Sent an email to ..." over a refusal.
  assert.equal(seen.completed.tool.value.args.message, `${tool.MAIL_SEND_FAILED_PREFIX}jane@client.example`);
});

test("MAIL-3: a tool call that threw still draws as a mail that did not go", async () => {
  const d = deps();
  const built = tool.createSendEmailTool(d.dependencies);
  // The path unparseable arguments and an execution timeout both take. Its row used to serialize to
  // `{}`, which the console reads as "no recipient" and headlines with its fallback sentence --
  // "Sent an email" -- for a tool that never ran.
  const call = built.serializeError(new Error("Invalid arguments"));
  assert.equal(call.tool.case, "sendToUserToolCall");
  assert.equal(call.tool.value.args.message, tool.MAIL_SEND_FAILED_PREFIX);
  assert.equal(call.tool.value.result.result.case, "error");
  assert.match(call.tool.value.result.result.value.error, /Invalid arguments/);
});

test("MAIL-3: a bot with no address of its own says so and posts nothing", async () => {
  const d = deps({ readMail: () => null });
  const built = tool.createSendEmailTool(d.dependencies);
  const { result, seen } = await runTool(built, args());
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /do not have an email address of your own/);
  assert.equal(d.posted.length, 0, "nothing may be attempted without an address to send from");
  assert.equal(seen.completed.tool.value.args.message, `${tool.MAIL_SEND_FAILED_PREFIX}jane@client.example`);
});

test("MAIL-3: a box with no relay says so rather than blaming the relay for refusing", async () => {
  const d = deps({ resolveRelay: () => undefined });
  const built = tool.createSendEmailTool(d.dependencies);
  const { result } = await runTool(built, args());
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /no mail service in front of it/);
  assert.equal(d.posted.length, 0);
});

test("MAIL-3: a call outside an agent run fails plainly instead of sending as nobody", async () => {
  const d = deps({ getAgentId: () => undefined });
  const built = tool.createSendEmailTool(d.dependencies);
  const { result } = await runTool(built, args());
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /outside an agent run/);
  assert.equal(d.posted.length, 0);
});

test("MAIL-3: a dependency that throws is a refusal, never a send of unknown outcome", async () => {
  const d = deps({ post: async () => { throw new Error("socket hang up"); } });
  const built = tool.createSendEmailTool(d.dependencies);
  const { result } = await runTool(built, args());
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /socket hang up/);
});

// ---- the withhold --------------------------------------------------------------------------

const tool_ = (name) => ({ name, toolIdentifier: name, execute: async () => ({}) });
const hostFor = (overrides = {}) => ({
  isSubagentRunner: false,
  isSharedRoomRunner: false,
  isBoxScopedSubagent: false,
  isComputerUseSubagent: false,
  isBrowserUseSubagent: false,
  isSystemPromptOverridden: false,
  remoteBoxHasDesktop: false,
  getConversationId: () => AGENT,
  getRemoteBoxAvailable: () => false,
  cloudAgentsDisabledByTeam: () => true,
  spotlightEnabled: () => false,
  localMachineConnected: () => false,
  factories: {
    sendMessage: () => tool_("SendMessage"),
    sendEmail: () => tool_("send_email"),
  },
  ...overrides,
});
const turnInput = { autoReviewModes: { hostShell: "off", boxShell: "off", mcp: "off", computer: "off", automationWrite: "off", cloudAgent: "off", subagentLaunch: "off" } };

/** A sand root holding one agent-mail.json, and the env that points the host at it. */
function boxWith(mail, base = R750_BASE) {
  const root = freshRoot();
  mkdirSync(root, { recursive: true });
  if (mail != null) writeFileSync(path.join(root, "agent-mail.json"), JSON.stringify(mail), "utf8");
  return { SAND_DATA_ROOT: root, SAND_HOST_BUNDLE_S3_BASE_URL: base };
}

/** Build one toolset under `env`, returning the offered names and the withheld list off the trace. */
function offeredUnder(env, hostOverrides = {}) {
  const restore = {};
  for (const [key, value] of Object.entries({ ...env, SAND_TOOL_TRACE: "1" })) {
    restore[key] = process.env[key];
    process.env[key] = value;
  }
  const lines = [];
  const info = console.info;
  console.info = (line) => { lines.push(String(line)); };
  let names;
  const turn = hostOverrides.isBoxScopedSubagent === true
    ? { ...turnInput, subagentConfigs: [] }
    : turnInput;
  try {
    names = toolset.buildTurnTools(hostFor(hostOverrides), turn, {}).getAllTools().map((entry) => entry.name);
  } finally {
    console.info = info;
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const traced = lines.map((line) => {
    const at = line.indexOf("[sand][toolset] ");
    if (at < 0) return null;
    try { return JSON.parse(line.slice(at + "[sand][toolset] ".length)); } catch { return null; }
  }).filter(Boolean).at(-1);
  return { names, withheld: traced?.withheld ?? [] };
}

const wired = {
  domain: "myagents.email", canSend: true, updatedAt: 1,
  addresses: { [AGENT]: OWN },
};

test("MAIL-3: the send tool is offered only on a box the relay has switched on", () => {
  const { names, withheld } = offeredUnder(boxWith(wired));
  assert.ok(names.includes("send_email"), `send_email offered (got ${names.join(", ")})`);
  assert.equal(withheld.some((entry) => /send.?email/i.test(entry.tool)), false,
    "an offered tool is not also on the withheld list");
});

test("MAIL-3: canSend false withholds it by name and reason, rather than leaving it merely absent", () => {
  const { names, withheld } = offeredUnder(boxWith({ ...wired, canSend: false }));
  assert.ok(!names.includes("send_email"),
    "the relay still says this workspace cannot send, and the bot's own standing facts say so too");
  const row = withheld.find((entry) => /send.?email/i.test(entry.tool));
  assert.ok(row != null, "a withheld tool has to be reported with its reason, not just missing");
  assert.equal(row.reason, "mail_send_off");
});

test("MAIL-3: a bot with no row in the directory is withheld for the same reason", () => {
  const { names, withheld } = offeredUnder(boxWith({
    ...wired, addresses: { "some-other-agent": OWN },
  }));
  assert.ok(!names.includes("send_email"));
  assert.equal(withheld.find((entry) => /send.?email/i.test(entry.tool))?.reason, "mail_send_off");
});

test("MAIL-3: a box with no directory at all, and a box with no relay, are both withheld", () => {
  const none = offeredUnder(boxWith(null));
  assert.ok(!none.names.includes("send_email"));
  assert.equal(none.withheld.find((entry) => /send.?email/i.test(entry.tool))?.reason, "mail_send_off");

  const noRelay = offeredUnder(boxWith(wired, DEFAULT_S3_BASE));
  assert.ok(!noRelay.names.includes("send_email"),
    "an ordinary install has no relay to send through and must not grow the tool");
  assert.equal(noRelay.withheld.find((entry) => /send.?email/i.test(entry.tool))?.reason, "mail_send_off");
});

test("MAIL-3: a box-scoped subagent never gets it, whatever the directory says", () => {
  // The one subagent shape that reaches the push sites at all: a plain Task subagent returns an
  // empty toolset several hundred lines earlier, a box-scoped one does not. Mail goes out under the
  // business's name and the chip that says it went is drawn in the conversation the person is
  // watching, which a subagent's run is not. Measured on grok-bot-local-vm 2026-09-09 18:26Z, a
  // box-scoped computerUse subagent's trace carries its own `sand-subagent-<uuid>` id and four
  // tools (Shell, Read, Computer, report_problem); the guard is for the other path, where
  // `getConversationId` defaults to the PARENT's session id and would hand over the parent's row.
  const { names, withheld } = offeredUnder(boxWith(wired), {
    isSubagentRunner: true,
    isBoxScopedSubagent: true,
    isComputerUseSubagent: true,
    remoteBoxHasDesktop: true,
    getRemoteBoxAvailable: () => true,
    factories: {
      boxShell: () => tool_("Shell"),
      boxRead: () => tool_("Read"),
      computer: () => tool_("Computer"),
      sendEmail: () => tool_("send_email"),
    },
  });
  assert.deepEqual(names, ["Shell", "Read", "Computer"], "the box tools, and no send among them");
  const row = withheld.find((entry) => /send.?email/i.test(entry.tool));
  assert.equal(row?.reason, "subagent_runner",
    "and it says which of the two reasons it was, so an operator is not told the workspace is off");
});

test("MAIL-3: a cross-user room cannot send mail, because the room set is an allowlist", () => {
  assert.equal(toolset.SHARED_ROOM_TOOL_NAMES.has("send_email"), false);
  assert.equal(toolset.SHARED_ROOM_TEXT_ONLY_TOOL_NAMES.has("send_email"), false);
});
