// HANDBACK-1: the host half of the computer hand-off.
//
// Three things were wrong before this and each one is pinned here.
//
// Three vocabularies disagreed. A skip arrived as {trigger:"cancel"}, which wrote "cancelled" on the
// transcript entry AND resumed the agent with "the user handed the box back", so a step nobody did
// was indistinguishable from a step somebody did. There are now two words, handed_back and
// dismissed, the resume prompt is chosen from the RESOLUTION rather than from a raw trigger string,
// and rows already written with the old words are read through an alias.
//
// The pending record lived in a bare Map with no writer. A host restart forgot that the person still
// owed a step, while `awaitingUserResponse` (persisted in the agent's own db) kept the roster pill
// up: a pill with no card behind it. The record now goes through a sidecar the service owns.
//
// The status carried a picture. `pendingHandoff` was spread whole into every forever-box status,
// snapshot included, and that payload rides a 15 s heartbeat. It is shaped now.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(relativePath) {
  const bundled = await build({
    entryPoints: [path.join(repoRoot, relativePath)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
  });
  const code = bundled.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const {
  BoxHandoffService,
  aliasBoxResolution,
  decideBoxHandBack,
  shapeHandoffForStatus,
} = await load("source/host/extensions/session/box-handoff-service.ts");
const { resumeBoxHandoffPrompt } = await load(
  "source/host/extensions/transcript/box-handoff-resume.ts",
);

const pending = { requestId: "r1", instruction: "Sign in as super_admin", startedAt: 1_000 };

test("one vocabulary: every way out of a hand-off lands on handed_back or dismissed", () => {
  assert.deepEqual(decideBoxHandBack(undefined, "button"), { kind: "none" });

  // "button" is what the console's I'm-done control sends, and it is the whole point of the card.
  assert.equal(decideBoxHandBack(pending, "button").resolution, "handed_back");
  // Both skip spellings. "cancel" is what the old console sent and what wrote "cancelled" on disk.
  assert.equal(decideBoxHandBack(pending, "cancel").resolution, "dismissed");
  assert.equal(decideBoxHandBack(pending, "dismissed").resolution, "dismissed");
  // The object form the new skip command uses.
  assert.equal(decideBoxHandBack(pending, { resolution: "dismissed", trigger: "dismissed" }).resolution, "dismissed");
  assert.equal(decideBoxHandBack(pending, { trigger: "button" }).resolution, "handed_back");
  // A trigger nobody in this path set must not read as a skip: the person is owed the benefit of
  // the doubt, and the handed-back prompt makes the agent look at the screen before it continues.
  assert.equal(decideBoxHandBack(pending, "viewer-closed").resolution, "handed_back");
  assert.equal(decideBoxHandBack(pending, "something-nobody-set").resolution, "handed_back");

  const decision = decideBoxHandBack(pending, "cancel");
  assert.equal(decision.kind, "end");
  assert.equal(decision.requestId, "r1");
  assert.equal(decision.trigger, "cancel", "the raw trigger still travels for telemetry");
});

test("the alias reads the words already on disk", () => {
  assert.equal(aliasBoxResolution("completed"), "handed_back");
  assert.equal(aliasBoxResolution("cancelled"), "dismissed");
  assert.equal(aliasBoxResolution("handed_back"), "handed_back");
  assert.equal(aliasBoxResolution("dismissed"), "dismissed");
  // Anything else is honestly unknown. The console draws that as "no longer waiting", never as Done.
  assert.equal(aliasBoxResolution("unknown"), null);
  assert.equal(aliasBoxResolution(null), null);
  assert.equal(aliasBoxResolution(undefined), null);
});

test("the resume prompt is keyed off the resolution, not the trigger", () => {
  const declined = resumeBoxHandoffPrompt({ resolution: "dismissed", trigger: "dismissed" });
  const handedBack = resumeBoxHandoffPrompt({ resolution: "handed_back", trigger: "button" });
  const uncertain = resumeBoxHandoffPrompt({ resolution: "handed_back", trigger: "viewer-closed" });

  assert.match(declined, /dismissed your box help request/);
  assert.match(declined, /do not assume the step happened/);
  assert.match(handedBack, /handed the box back/);
  assert.match(handedBack, /read-only Screenshot tool/);
  assert.match(uncertain, /closed the box desktop viewer/);

  // The bug: this pair used to disagree. A "cancel" trigger wrote a skip resolution and still got
  // the handed-back prompt. Now the resolution decides, in both directions.
  assert.equal(resumeBoxHandoffPrompt({ resolution: "cancelled", trigger: "button" }), declined);
  assert.equal(resumeBoxHandoffPrompt({ resolution: "completed", trigger: "dismissed" }), handedBack);
  // viewer-closed only reaches its own prompt when the resolution is not a skip.
  assert.equal(resumeBoxHandoffPrompt({ resolution: "dismissed", trigger: "viewer-closed" }), declined);
  // Nothing known at all: look at the screen before continuing.
  assert.equal(resumeBoxHandoffPrompt({}), handedBack);
});

test("the status carries no picture, and nothing big", () => {
  assert.equal(shapeHandoffForStatus(null), null);
  const snapshot = `data:image/webp;base64,${"A".repeat(70_000)}`;
  const shaped = shapeHandoffForStatus({ ...pending, snapshotDataUrl: snapshot, snapshotAt: 2_000 });
  assert.deepEqual(shaped, {
    requestId: "r1",
    instruction: "Sign in as super_admin",
    startedAt: 1_000,
    snapshotAt: 2_000,
  });
  assert.equal("snapshotDataUrl" in shaped, false);
  for (const [key, value] of Object.entries(shaped)) {
    assert.ok(
      Buffer.byteLength(String(value), "utf8") <= 200,
      `${key} is ${Buffer.byteLength(String(value), "utf8")} bytes; the status rides every heartbeat`,
    );
  }
  assert.equal(shapeHandoffForStatus(pending).snapshotAt, undefined);
});

function fakeStore(seed = {}) {
  const state = { records: { ...seed }, writes: 0 };
  return {
    state,
    loadPersisted: () => state.records,
    savePersisted: (records) => {
      state.records = records;
      state.writes += 1;
    },
  };
}

test("a service built over a store that already holds a record comes back owing the step", async () => {
  const store = fakeStore({
    a1: { requestId: "r-restart", instruction: "Sign in to clientsync.dev as super_admin", startedAt: 42 },
  });
  const ended = [];
  const service = new BoxHandoffService({
    ...store,
    onEnded: (event) => void ended.push(event),
  });

  const live = service.get("a1");
  assert.deepEqual(live, {
    requestId: "r-restart",
    instruction: "Sign in to clientsync.dev as super_admin",
    startedAt: 42,
  });

  // The second half of the same guarantee: the tool must still refuse to ask twice after a restart.
  const second = service.start({ agentId: "a1", instruction: "Sign in again" });
  assert.equal(second.kind, "already-pending");
  assert.equal(second.requestId, "r-restart");
  assert.equal(second.instruction, "Sign in to clientsync.dev as super_admin");

  await service.end("a1", { resolution: "dismissed", trigger: "dismissed" });
  assert.deepEqual(ended, [
    { agentId: "a1", requestId: "r-restart", resolution: "dismissed", trigger: "dismissed" },
  ]);
  assert.equal(service.get("a1"), null);
  assert.deepEqual(store.state.records, {}, "end() clears the persisted record");
});

test("a malformed sidecar is ignored rather than thrown, and the good rows still load", () => {
  const service = new BoxHandoffService({
    loadPersisted: () => ({
      broken: { instruction: "no request id", startedAt: 1 },
      alsoBroken: null,
      empty: { requestId: "", instruction: "x", startedAt: 1 },
      good: { requestId: "r-good", instruction: "Approve the prompt", startedAt: 7 },
    }),
  });
  assert.equal(service.get("broken"), null);
  assert.equal(service.get("alsoBroken"), null);
  assert.equal(service.get("empty"), null);
  assert.equal(service.get("good").requestId, "r-good");
});

test("a store that throws on read cannot take the host down with it", () => {
  const service = new BoxHandoffService({
    loadPersisted: () => {
      throw new Error("sidecar unreadable");
    },
    savePersisted: () => {
      throw new Error("sidecar unwritable");
    },
  });
  assert.equal(service.get("a1"), null);
  assert.equal(service.start({ agentId: "a1", instruction: "Sign in" }).kind, "started");
  assert.equal(service.get("a1").instruction, "Sign in");
});

test("start, forget and end all write through", async () => {
  const store = fakeStore();
  const started = [];
  const service = new BoxHandoffService({
    ...store,
    now: () => 5_000,
    onStarted: (event) => void started.push(event),
  });

  const outcome = service.start({ agentId: "a1", instruction: "Approve the 2FA prompt" });
  assert.equal(outcome.kind, "started");
  assert.deepEqual(started, [{ agentId: "a1", instruction: "Approve the 2FA prompt" }]);
  assert.deepEqual(store.state.records, {
    a1: { requestId: outcome.requestId, instruction: "Approve the 2FA prompt", startedAt: 5_000 },
  });
  assert.equal(service.get("a1").startedAt, 5_000);

  service.forget("a1");
  assert.deepEqual(store.state.records, {});
  assert.equal(service.get("a1"), null);

  // Ending a hand-off nobody is waiting on is a no-op, not a write and not an onEnded.
  const writesBefore = store.state.writes;
  await service.end("a1", "button");
  assert.equal(store.state.writes, writesBefore);
});

test("what gets persisted is the record, never the picture", async () => {
  const store = fakeStore();
  const service = new BoxHandoffService({
    ...store,
    now: () => 9_000,
    timeoutMs: 50,
    grabScreenshot: async () => "d2VicA==",
  });
  const outcome = service.start({ agentId: "a1", instruction: "Sign in" });
  // The snapshot lands out of band; give its microtasks a turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(service.get("a1").snapshotDataUrl, /^data:image\/webp;base64,/);
  assert.deepEqual(store.state.records, {
    a1: { requestId: outcome.requestId, instruction: "Sign in", startedAt: 9_000 },
  });
  assert.equal(shapeHandoffForStatus(service.get("a1")).snapshotAt, 9_000);
});
