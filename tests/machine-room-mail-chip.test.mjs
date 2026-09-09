// MAIL-3, the console half: the quiet chip a person sees when their bot sends an email.
//
// The block is SLICED OUT of gateway-adapter.js and run here rather than copied, the same way
// tests/machine-room-feedback.test.mjs does it. A copy would go on passing after the console
// changed, which on a promise about what a customer sees is worse than no test at all.
//
// What each case is for:
//
//   - Mail leaves the workspace with the business's name on it. The person has to see that it
//     went, and to whom, in plain words. host-notes-read-as-errors.md is the rule the wording
//     follows: no prefix, no underline, nothing that reads as a machine's verdict.
//   - A REFUSED send must never draw "Sent an email to ...". The outline carries no result this
//     page can read -- a non-shell tool row is {kind, id, name, status, summary} and
//     getOutlineToolCallStatus only ever says "failed" for a task -- so the outcome rides the one
//     args string the row does carry, behind a fixed marker, and this pins that it is read.
//   - The row is DETAIL-LESS on purpose. An empty detail is what makes app.js draw a muted bubble
//     rather than an expander; an expander here would put the mail's subject and body on the page
//     beside the conversation, which is the customer's own words going out under their name.
//   - A row whose name is not in TOOL_LABELS is headlined with the raw proto name. That is exactly
//     how `sendToUserToolCall` would leak onto a customer's screen, so the label is pinned too.
//   - And the row survives at all only because its name misses NOT_A_RECEIPT. A communicate-shaped
//     tool would have been filtered out one function before the renderer and a sent mail would
//     have left no mark on the page.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterPath = path.join(repoRoot, "ui/machine-room/gateway-adapter.js");

const between = (source, startMark, endMark, what) => {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error(`could not slice ${what} out of the console source`);
  return source.slice(start, end);
};

// The same slice tests/machine-room-feedback.test.mjs takes, so the two tests cannot drift apart
// into disagreeing copies of one block.
async function loadToolRow() {
  const source = await readFile(adapterPath, "utf8");
  const body = between(source, "  const PROBLEM_REPORT_TOOL_CALL =", "  const messageKey =", "the tool-row block");
  return new Function(
    `${body}\nreturn { toolRowText, TOOL_LABELS, MAIL_SEND_TOOL_CALL, MAIL_SEND_FAILED_PREFIX };`,
  )();
}

// What the outline actually hands the page for this tool: the args, serialized whole, as JSON.
const row = (message, status = "done") => ({
  id: "t1",
  name: "sendToUserToolCall",
  status,
  summary: JSON.stringify({ message }),
});

test("MAIL-3: a sent mail draws one plain line naming who it went to, with no tool name", async () => {
  const { toolRowText, MAIL_SEND_TOOL_CALL } = await loadToolRow();
  assert.equal(MAIL_SEND_TOOL_CALL, "sendToUserToolCall");
  const drawn = toolRowText(row("jane@client.example"));
  assert.equal(drawn.text, "Sent an email to jane@client.example");
  assert.equal(drawn.detail, "", "an empty detail is what makes app.js draw a bubble and not an expander");
  assert.equal(drawn.kind, "Email");
  for (const leak of ["send_email", "sendToUser", "ToolCall", "SEND_EMAIL"]) {
    assert.doesNotMatch(drawn.text + drawn.detail, new RegExp(leak, "i"), `${leak} must not reach the page`);
  }
});

test("MAIL-3: a mail that did not send says so, and never reads as one that did", async () => {
  const { toolRowText, MAIL_SEND_FAILED_PREFIX } = await loadToolRow();
  assert.equal(MAIL_SEND_FAILED_PREFIX, "not sent: ");
  const drawn = toolRowText(row(`${MAIL_SEND_FAILED_PREFIX}jane@client.example`));
  assert.equal(drawn.text, "Tried to email jane@client.example · it did not send");
  assert.equal(drawn.detail, "");
  assert.doesNotMatch(drawn.text, /^Sent/, "the one sentence a refusal may never begin with");
  // The marker itself is a machine's word and must not survive into the line a person reads.
  assert.doesNotMatch(drawn.text, /not sent:/);
});

test("MAIL-3: a row still in flight does not claim the mail has gone", async () => {
  const { toolRowText } = await loadToolRow();
  const drawn = toolRowText(row("jane@client.example", "pending"));
  assert.equal(drawn.text, "Sending an email to jane@client.example");
  assert.equal(drawn.detail, "");
});

test("MAIL-3: neither the subject nor the body can reach the page through this row", async () => {
  const { toolRowText } = await loadToolRow();
  // Even handed a summary carrying more than the recipient -- which the host does not send, and a
  // test that only checked the host would not notice if it started to -- the page draws one line.
  const drawn = toolRowText({
    id: "t2",
    name: "sendToUserToolCall",
    status: "done",
    summary: JSON.stringify({ message: "jane@client.example", subject: "SECRET-SUBJECT", text: "SECRET-BODY" }),
    output: "SECRET-OUTPUT",
  });
  assert.equal(drawn.text, "Sent an email to jane@client.example");
  assert.equal(drawn.detail, "");
  for (const leak of ["SECRET-SUBJECT", "SECRET-BODY", "SECRET-OUTPUT"]) {
    assert.doesNotMatch(drawn.text + drawn.detail, new RegExp(leak), `${leak} must not reach the page`);
  }
});

test("MAIL-3: a summary the page cannot read still never draws a proto name", async () => {
  const { toolRowText } = await loadToolRow();
  for (const summary of [undefined, "", "not json at all", "{}", JSON.stringify({ message: "" })]) {
    const drawn = toolRowText({ id: "t3", name: "sendToUserToolCall", status: "done", summary });
    assert.equal(drawn.text, "Sent an email", `a bare sentence, got ${JSON.stringify(drawn.text)}`);
    assert.equal(drawn.detail, "");
    assert.doesNotMatch(drawn.text, /sendToUser|ToolCall|\{|\}/,
      "the fallback for an unreadable row is words, never the machine's own name for it");
  }
  // The same for a failed row nobody can name a recipient on.
  const failed = toolRowText({ id: "t4", name: "sendToUserToolCall", status: "failed", summary: "" });
  assert.equal(failed.text, "An email did not send");
});

test("MAIL-3: the label is in the table, because a missing one is how a tool name leaks", async () => {
  const { TOOL_LABELS, MAIL_SEND_TOOL_CALL } = await loadToolRow();
  assert.equal(TOOL_LABELS[MAIL_SEND_TOOL_CALL], "Email");
  // And the row above it is untouched: the two chips share one table and one function.
  assert.equal(TOOL_LABELS.reportBugToolCall, "Report");
  assert.equal(TOOL_LABELS.shellToolCall, "Shell");
});

test("MAIL-3: the row survives the console's non-receipt filter, which is why it is drawn at all", async () => {
  const source = await readFile(adapterPath, "utf8");
  // Sliced out rather than retyped: the filter lives in a file other waves have open, and a copy
  // of the regex here would go on passing after the real one changed.
  const line = source.split("\n").find((one) => one.includes("const NOT_A_RECEIPT ="));
  assert.ok(line != null, "the console still has a NOT_A_RECEIPT filter");
  const NOT_A_RECEIPT = new Function(`${line.trim()}\nreturn NOT_A_RECEIPT;`)();
  assert.equal(NOT_A_RECEIPT.test("sendToUserToolCall"), false,
    "if this ever matches, a sent mail leaves no chip and the person sees nothing");
  assert.equal(NOT_A_RECEIPT.test("communicateUpdateToolCall"), true, "which is what a communicate tool would have been");
});
