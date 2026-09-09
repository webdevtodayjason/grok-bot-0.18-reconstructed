// TOOLS-READ-2 and TOOLS-READ-1, which are the same condition seen twice.
//
// Titan filed both from its own self-test: the Read tool refuses /home/box/sand-data/... and
// /home/box/agent-data/agents/<id>/profile.json as "inside a protected host-only store" while the
// Shell tool cats the same file. Two paths, one fence -- /home/box/agent-data is a symlink to
// sand-data and the guard resolves realpaths -- so they close together.
//
// The decision, written down here as a test rather than only in prose, because the asymmetry is
// intended and the next agent to find it will file it a third time otherwise:
//
//   1. The fence stays, and it stays on Read only. Read pulls a file INTO the model's context; the
//      shell runs a command whose output the agent already asked for. That is a CONTEXT boundary.
//   2. No shell fence ships. There is no deny list to add a line to -- the shell executors are
//      registered with no path or command filter -- and every exec daemon in the box runs as uid 0,
//      so any command-text glob is walked around with base64, a copy or a symlink. A partial fence
//      is worse theatre than an honest asymmetry. CUSTODY-1 (an unprivileged uid) is the real fix.
//   3. What ships is the wording: plain words, naming the boundary, true of the WHOLE store rather
//      than of secrets alone, and pointing the agent somewhere it can read.
//
// So this file asserts BOTH halves: the refusal reads the way the decision says, and the guard is
// still only ever asked about Read. docs/CUSTODY.md carries the same decision in prose.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".read-fence-test-"));
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

const {
  refusalMessage,
  assertPathOutsideProtectedRoots,
  SandProtectedPathError,
} = await load("source/host/box/protected-path-guard.ts", "protected-path-guard");

const SAMPLE = "/home/box/sand-data/connector-env-secrets.json";

test("the refusal is plain words, and it says why", () => {
  const message = refusalMessage(SAMPLE);
  // It names the boundary in words a person reads, and it is a sentence, not a status line.
  assert.match(message, /host-owned store/i, "it names what the path belongs to");
  assert.match(message, /boundary, not a fault/i,
    "the whole point: the agent stops reporting this as a product bug");
  assert.match(message, /\/home\/box/, "it points the agent somewhere it CAN read");
  assert.ok(message.includes(SAMPLE), "and it still names the path that was refused");

  // The old wording, which Titan filed twice. "protected host-only store and was refused" told the
  // agent nothing except that something was wrong, so it wrote it up as a fault.
  assert.doesNotMatch(message, /protected host-only store/i, "the old wording is gone");
  assert.doesNotMatch(message, /[—–]/, "no em dash: a person reads this");
  assert.doesNotMatch(message, /denied|forbidden|policy|violation|unauthori[sz]ed/i,
    "no security-console vocabulary for what is an ordinary boundary");

  // The half that is easy to get wrong. The fence is the ENTIRE sand-data root -- transcripts,
  // skills, gate records, agent stores -- so a message promising the path holds only secrets would
  // be false most of the times it fires. It may say credentials are in there. It may not say that
  // is all that is in there.
  assert.match(message, /credentials/i, "it is honest that credentials are among what is behind it");
  assert.match(message, /agent records|settings/i,
    "and honest that the store is more than secrets, because the fence is the whole root");
  assert.doesNotMatch(message, /only (the )?secrets|nothing but|secrets only/i,
    "it must not claim the store holds only secrets");
});

test("the refusal is the same sentence whichever path inside the store is asked for", () => {
  // TOOLS-READ-1 and TOOLS-READ-2 were filed as two bugs about two paths. One message, one fence.
  const first = refusalMessage("/home/box/sand-data/agents/abc/profile.json");
  const second = refusalMessage("/home/box/agent-data/agents/abc/profile.json");
  const strip = (text) => text.replace(/[^:]*$/, "");
  assert.equal(strip(first), strip(second), "same reason, only the path differs");
});

test("the fence covers the whole store, and the symlink road into it as well", async () => {
  // agent-data is a symlink to sand-data on a real box, which is why TOOLS-READ-1 and TOOLS-READ-2
  // are one condition: the guard resolves realpaths, so the alias is refused too.
  const root = mkdtempSync(path.join(tmpdir(), "read-fence-"));
  roots.push(root);
  const store = path.join(root, "sand-data");
  mkdirSync(path.join(store, "agents", "abc"), { recursive: true });
  writeFileSync(path.join(store, "agents", "abc", "profile.json"), "{}");
  symlinkSync(store, path.join(root, "agent-data"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "notes.md"), "the agent's own file");

  const refuses = async (candidate) => {
    await assert.rejects(
      () => assertPathOutsideProtectedRoots([store], candidate, workspace),
      (error) => {
        assert.ok(error instanceof SandProtectedPathError);
        assert.match(error.message, /boundary, not a fault/);
        return true;
      },
      `${candidate} is inside the store and has to be refused`,
    );
  };
  await refuses(path.join(store, "agents", "abc", "profile.json"));
  await refuses(path.join(store, "connector-env-secrets.json"));
  await refuses(path.join(root, "agent-data", "agents", "abc", "profile.json"));
  await refuses(store);

  // And the agent's own files are not fenced, which is what the message points at.
  await assertPathOutsideProtectedRoots([store], path.join(workspace, "notes.md"), workspace);
  await assertPathOutsideProtectedRoots([store], "notes.md", workspace);
});

test("the shell is deliberately NOT fenced, and nothing in the tree pretends it is", async () => {
  // The second half of the decision, asserted rather than assumed. If somebody later adds a path
  // or command filter to the shell executors, this test fails and they have to come back here,
  // read the reasoning, and either change the decision on purpose or drop the filter. That is the
  // point: the asymmetry is written down as intended behaviour, not left to be rediscovered.
  const { readFile } = await import("node:fs/promises");
  const resources = await readFile(
    new URL("../source/host/runner/remote-box-resources.ts", import.meta.url),
    "utf8",
  );
  assert.match(resources, /shell/i, "this is the file that registers the box's shell executors");
  assert.doesNotMatch(resources, /assertPathOutsideProtectedRoots|protectedBoxPaths/,
    "no shell fence ships: see docs/CUSTODY.md. CUSTODY-1, an unprivileged uid, is the real fix, "
    + "and a command-text filter under uid 0 is walked around with base64, a copy or a symlink.");

  // The fence is passed in exactly one place, and it is the box's file-read guard.
  const production = await readFile(
    new URL("../source/host/box/production.ts", import.meta.url),
    "utf8",
  );
  assert.match(production, /withFileReadGuard/,
    "the guard reaches the product through the file-read guard on the box accessor, and only there");
});
