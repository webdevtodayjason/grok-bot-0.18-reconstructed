import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Two things this differs from the usual loadModule in tests/, both forced by how much of the host
// graph sand-host.ts reaches:
//   - `packages: "external"`, because that graph pulls in a CommonJS dependency that requires "fs"
//     at load time, and inlined into one ESM file that require throws before a line of host code
//     runs. Nothing here needs those packages read.
//   - the bundle is staged under node_modules/ rather than in os.tmpdir(), because an external
//     import only resolves from a file that sits inside this repo's module tree.
async function loadModule(entry) {
  const stage = await mkdtemp(path.join(repoRoot, "node_modules", ".job-bus-events-test-"));
  const output = path.join(stage, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22", packages: "external", logLevel: "silent" });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(stage, { recursive: true, force: true }) };
}

// The seam docs/JOB-BUS.md section 5 names: the store emits `{type:"job-bus", jobId, status}` on
// `hostEvents`, and the console's Job bus card only ever sees it if it comes back out of the
// gateway's /events stream. Those are two different buses -- `hostEvents` is the push-notification
// fan-out, whose only subscriber switches on `event.kind` -- so without the forward wireEvents
// installs, every job transition was emitted into a bus nothing on a browser reads and the card
// stayed stale until its next poll. This test drives the real class rather than a copy of the
// rule, because a copy would have gone on passing the whole time the seam was broken.
//
// wireEvents is reached directly: the alternative is SandHost.start(), which walks the entire
// extension graph and needs a box. Everything it touches here is stubbed, and `api()` answering an
// empty object is what makes the rest of the method a no-op (`optionalMethod(...)?.()`).
function wiredHost(SandHost) {
  const host = new SandHost({});
  host.hostExtensions = { api: () => ({}) };
  host.wireEvents();
  const seen = [];
  host.subscribe((event) => { seen.push(event); });
  // subscribe() greets a new listener with the current disk-pressure level. Drop it: this test is
  // about what arrives afterwards.
  seen.length = 0;
  return { host, seen };
}

test("a job-bus transition on the host event bus reaches the gateway event stream", async () => {
  const { module, dispose } = await loadModule("source/host/sand-host.ts");
  try {
    const { host, seen } = wiredHost(module.SandHost);

    host.hostEvents.emit({ type: "job-bus", jobId: "job_abc123", status: "running" });

    assert.equal(seen.length, 1, "one frame on the stream per transition");
    const [envelope] = seen;
    assert.equal(envelope.channel, "job-bus", "named on `channel`, like every other frame, so `?channels=job-bus` works");
    assert.deepEqual(envelope.payload, { type: "job-bus", jobId: "job_abc123", status: "running" },
      "the event the contract names, forwarded whole");

    // Exactly what ui/machine-room/gateway-adapter.js does with the frame.
    const body = envelope.payload ?? envelope;
    assert.equal(body.jobId, "job_abc123");
    assert.equal(body.status, "running");
  } finally {
    await dispose();
  }
});

test("every status the store can write is forwarded, and nothing else on that bus is", async () => {
  const { module, dispose } = await loadModule("source/host/sand-host.ts");
  try {
    const { host, seen } = wiredHost(module.SandHost);

    for (const status of ["queued", "running", "needs_human", "done", "failed", "cancelled"]) {
      host.hostEvents.emit({ type: "job-bus", jobId: `job_${status}`, status });
    }
    assert.deepEqual(seen.map((event) => event.payload.status),
      ["queued", "running", "needs_human", "done", "failed", "cancelled"]);

    // The notification events that share this bus must not turn into stream frames: they carry
    // agent rows and inline avatars, and the stream is a different audience with a different shape.
    seen.length = 0;
    host.hostEvents.emit({ kind: "notification-agent-forgotten", agentId: "a1" });
    host.hostEvents.emit({ kind: "notification-baseline", agents: [] });
    host.hostEvents.emit(null);
    host.hostEvents.emit("job-bus");
    assert.deepEqual(seen, [], "only the job-bus event crosses over");
  } finally {
    await dispose();
  }
});

test("the forwarded frame survives the /events stream's own two filters", async () => {
  const server = await loadModule("source/host/gateway-server.ts");
  const protocol = await loadModule("source/host/gateway-protocol.ts");
  try {
    const frame = { channel: "job-bus", payload: { type: "job-bus", jobId: "job_abc123", status: "done" } };
    // handleEvents drops a frame whose channel is not subscribed, and rewrites frames that carry
    // inline avatars. A channel-less `{type:"job-bus", ...}` would have failed the first of those
    // for any client that asked for channels at all, which is why the forward wraps it.
    const subscribed = server.module.parseSubscribedChannels(new URL("http://box/events?channels=job-bus,agents"));
    assert.ok(subscribed.has(frame.channel), "a channel-filtered subscriber can ask for it by name");
    assert.equal(protocol.module.stripInlineAvatarsFromEvent(frame), frame, "and it is passed through untouched");
  } finally {
    await server.dispose();
    await protocol.dispose();
  }
});
