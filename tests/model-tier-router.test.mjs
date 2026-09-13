import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRouter() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-tier-router-"));
  const outfile = path.join(dir, "router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/model-tier-router.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { module: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), dispose: () => rm(dir, { recursive: true, force: true }) };
}

const choose = (router, workspacePin = "auto", talkAvailable = true) =>
  router.choose({ workModel: "plan-zai", talkAvailable, workspacePin });

test("ordinary turns and light routines use talk when the deployment exists", async () => {
  const loaded = await loadRouter();
  try {
    assert.deepEqual(choose(new loaded.module.ModelTierTurnRouter()), { tier: "talk", model: "plan-zai-talk", reason: "automatic" });
    assert.equal(choose(new loaded.module.ModelTierTurnRouter({ requestSource: "automation" })).tier, "talk");
    assert.deepEqual(choose(new loaded.module.ModelTierTurnRouter(), "auto", false), { tier: "work", model: "plan-zai", reason: "single-tier" });
    assert.equal(loaded.module.talkModelFor("customer-model"), null, "customer-owned models never grow a guessed alias");
  } finally { await loaded.dispose(); }
});

test("coding, computer planning, heavy routines, and the first heavy tool use work", async () => {
  const loaded = await loadRouter();
  try {
    for (const context of [
      { isCodeSandboxTask: true }, { isCodingAgent: true }, { isComputerUseSubagent: true },
      { heavyRoutine: true }, { requestSource: "code-sandbox" },
    ]) assert.equal(choose(new loaded.module.ModelTierTurnRouter(context)).tier, "work");

    for (const name of ["Shell", "Write", "Edit", "Computer", "code_task", "apply_patch"]) {
      const router = new loaded.module.ModelTierTurnRouter();
      assert.equal(choose(router).tier, "talk");
      router.observeToolCall(name);
      assert.equal(choose(router).tier, "work", name);
    }
    const computer = new loaded.module.ModelTierTurnRouter({ isComputerUseSubagent: true });
    assert.equal(choose(computer).tier, "work", "computer planning starts on work");
    computer.observeToolCall("Screenshot");
    assert.deepEqual(choose(computer), { tier: "talk", model: "plan-zai-talk", reason: "screenshot-read" });
    assert.equal(choose(computer).tier, "work", "the screenshot read is one model call");
  } finally { await loaded.dispose(); }
});

test("two consecutive tool errors upgrade while an intervening success resets the streak", async () => {
  const loaded = await loadRouter();
  try {
    const error = { role: "tool", content: [{ type: "tool-result", result: { isError: true, error: "nope" } }] };
    const success = { role: "tool", content: [{ type: "tool-result", result: { value: "ok" } }] };
    const router = new loaded.module.ModelTierTurnRouter();
    router.observeMessages([error]);
    assert.equal(choose(router).tier, "talk");
    router.observeMessages([success, error]);
    assert.equal(choose(router).tier, "talk");
    router.observeMessages([error]);
    assert.equal(choose(router).tier, "work");
  } finally { await loaded.dispose(); }
});

test("workspace pins win over the conversation pin and automatic upgrades", async () => {
  const loaded = await loadRouter();
  try {
    const router = new loaded.module.ModelTierTurnRouter({ thinkHarder: true, isCodingAgent: true });
    assert.equal(choose(router, "talk").tier, "talk");
    assert.equal(choose(new loaded.module.ModelTierTurnRouter(), "work").tier, "work");
    assert.equal(choose(new loaded.module.ModelTierTurnRouter({ thinkHarder: true }), "auto").tier, "work");
    assert.equal(choose(router, "talk", false).tier, "work", "an unavailable talk deployment is never guessed");
  } finally { await loaded.dispose(); }
});

test("observeMessages takes a single message, not only an array: the ack-reminder appends one", async () => {
  // 2026-09-12: the ack-reminder and send-message-reminder middlewares append ONE message object,
  // not an array, and observeMessages threw "messages.slice is not a function", ended the turn, and
  // the ack-redrive re-fired it into a duplicate-ticket storm.
  const loaded = await loadRouter();
  try {
    const shell = { role: "assistant", content: [{ type: "tool-call", toolName: "Shell", args: {} }] };
    const router = new loaded.module.ModelTierTurnRouter();
    assert.doesNotThrow(() => router.observeMessages(shell), "a single message must not throw");
    assert.equal(choose(router).tier, "work", "and the single heavy tool call still upgrades the turn");
    const empty = new loaded.module.ModelTierTurnRouter();
    assert.doesNotThrow(() => empty.observeMessages(null), "null or undefined is a no-op, never a throw");
    assert.equal(choose(empty).tier, "talk");
  } finally { await loaded.dispose(); }
});

test("only this turn's tool calls count: a shell call before the last user message does not make the next turn heavy", async () => {
  const loaded = await loadRouter();
  try {
    const shell = { role: "assistant", content: [{ type: "tool-call", toolName: "Shell", args: {} }] };
    const user = { role: "user", content: "say hello" };
    const earlier = new loaded.module.ModelTierTurnRouter();
    earlier.observeMessages([shell, { role: "tool", content: [{ type: "tool-result", result: { value: "ok" } }] }, user]);
    assert.equal(choose(earlier).tier, "talk");
    const thisTurn = new loaded.module.ModelTierTurnRouter();
    thisTurn.observeMessages([user, shell]);
    assert.equal(choose(thisTurn).tier, "work");
  } finally { await loaded.dispose(); }
});
