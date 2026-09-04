// The host blocks an agent on an approval, a local-tool permission ask, or a widget question by
// writing a send-message entry whose `message` carries NO `.content`. The adapter read
// `message.content`, produced an empty string, and dropped the entry -- so a blocked agent showed
// nothing to click and simply never answered.
//
// This box runs with autoReviewInstructions armed and localToolPermission "ask", so that path is
// not exotic: asking a worker to send an email is enough. The host will not raise one on demand,
// so this pins the parser against the exact shapes host source emits:
//   auto-review-approval  source/host/extensions/auto-review/auto-review-service.ts
//   local-tool-permission source/host/host-runner-composition.ts
//   widget                source/host/host-gateway-api.ts respondToWidget
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The adapter is an IIFE that attaches to window and opens an EventSource at load; give it just
// enough of a page to evaluate, then reach in for the two pure functions worth pinning.
async function loadAdapterInternals() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { cardOf, messagesOf };\n  global.__bootMachineRoom =",
  );
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    EventSource: function () { return { onmessage: null }; },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    open: () => {},
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return fn(window, async () => ({ ok: true, text: async () => "{}" }));
}

const { cardOf, messagesOf } = await loadAdapterInternals();

test("an armed auto-review approval becomes an answerable card", () => {
  const card = cardOf({
    kind: "send-message",
    message: {
      type: "auto-review-approval",
      approval: {
        requestId: "req-1", status: "pending",
        summary: "Send an email to jason@webdevtoday.com",
        reason: "Matches your rule: ask before sending email",
        proposedRule: "Always allow email to jason@webdevtoday.com",
      },
    },
  });
  assert.equal(card.kind, "auto-review");
  assert.equal(card.requestId, "req-1");
  assert.match(card.title, /Send an email/);
  assert.match(card.detail, /ask before sending email/);
  assert.equal(card.rule, "Always allow email to jason@webdevtoday.com");
});

test("a local tool permission ask becomes an answerable card", () => {
  const card = cardOf({
    kind: "send-message",
    message: { type: "local-tool-permission", ask: { requestId: "req-2", status: "pending", action: "Run", target: "rm -rf build" } },
  });
  assert.equal(card.kind, "local-tool");
  assert.equal(card.requestId, "req-2");
  assert.match(card.title, /rm -rf build/);
});

test("a widget question keeps the host's own options", () => {
  const card = cardOf({
    kind: "send-message",
    message: { type: "widget", widget: { prompt: "Which ticket first?", options: ["#44845", "#44613"] } },
  });
  assert.equal(card.kind, "widget");
  assert.deepEqual(card.options, ["#44845", "#44613"]);
});

// CP-10 item 2: this UI used to refuse the request and tell the operator to answer it in the
// host app. submitSecret { entryId, value, agentId } is a real host command
// (widget-responses.ts:355 -> routeSecret -> storeConnectorCredential, then the agent resumes),
// so the card now carries the entry id the host asks by, plus the field and connector it names.
test("a credential request carries the entry id, field and connector the host asks by", () => {
  const card = cardOf({
    kind: "send-message", id: "entry-7",
    message: { type: "secret-request", secretRequest: { label: "the Linear API key", target: { kind: "channel-credential", platform: "linear", field: "apiKey" } } },
  });
  assert.equal(card.kind, "secret");
  assert.equal(card.entryId, "entry-7");
  assert.equal(card.field, "apiKey");
  assert.equal(card.platform, "linear");
  assert.equal(card.status, "pending");
  assert.match(card.title, /the Linear API key/);
  assert.match(card.detail, /never written into this conversation/i);
});

// The host's own stamp on the entry, not anything this page remembers: an answered request stops
// offering the input on the next read, the same way an answered widget does.
test("a credential request the host has already taken is not still asking", () => {
  const card = cardOf({
    kind: "send-message", id: "entry-8", secretProvided: true,
    message: { type: "secret-request", secretRequest: { label: "a token", target: { kind: "channel-credential", platform: "slack", field: "token" } } },
  });
  assert.equal(card.status, "provided");
});

test("ordinary agent speech is not mistaken for a decision", () => {
  assert.equal(cardOf({ kind: "send-message", message: { type: "text", content: "hello" } }), null);
});

test("a decision entry survives the transcript filter that used to drop it", () => {
  // The regression in one assertion: no .content anywhere, so the old code produced text:"" and
  // .filter(m => m.text) discarded it. An agent blocked on this showed an empty conversation.
  const messages = messagesOf([
    { kind: "message", role: "user", content: "send that email", timestampMs: 1 },
    { kind: "send-message", id: "entry-9", timestampMs: 2,
      message: { type: "auto-review-approval", approval: { requestId: "r", status: "pending", summary: "Send an email" } } },
  ], "Atera Triage");

  assert.equal(messages.length, 2, "the approval entry must not be filtered out");
  const decision = messages.find((m) => m.type === "decision");
  assert.ok(decision, "the approval must arrive typed as a decision");
  assert.equal(decision.id, "entry-9", "the id is what resolveAutoReviewApproval sends back as entryId");
  assert.equal(decision.card.status, "pending");
});

test("agent text still renders normally alongside decisions", () => {
  const messages = messagesOf([
    { kind: "send-message", id: "a", timestampMs: 3, message: { type: "text", content: "Done." } },
  ], "Atera Triage");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "text");
  assert.equal(messages[0].text, "Done.");
});
