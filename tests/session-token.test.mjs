// TENANT-2, item 1. The session token moved from cp/ to ui/ and cp/session.mjs became a re-export.
//
// The move is the whole point: the relay is the side that ships everywhere (deploy/r750/sync.sh
// copies ui/*.mjs, and each tenant mounts that directory read only), and it cannot import a file
// that exists only inside the control plane's image. The alternative to moving it was a second copy
// of the verifier in ui/, and two verifiers that disagree by one line look exactly like a customer
// typing the wrong password. So what these tests hold is not "the file exists" but "there is one
// implementation": the same function objects on both sides, a token minted through one name
// verifying through the other, and the image copying the file its own import now needs.
//
// tests/cp-session.test.mjs is unchanged and still imports ../cp/session.mjs. That it keeps passing
// is half the proof; this file is the other half.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cp from "../cp/session.mjs";
import * as ui from "../ui/session-token.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPORTS = [
  "SESSION_VERSION", "SESSION_TTL_MS", "base64urlDecode", "base64urlEncode",
  "mintSessionToken", "tenantOfUnverifiedToken", "tenantSessionSecret", "verifySessionToken",
];

test("cp/session.mjs re-exports ui/session-token.mjs, the same objects and not a copy", () => {
  for (const name of EXPORTS) {
    assert.ok(name in ui, `ui/session-token.mjs must export ${name}`);
    // Identity, not equality. Two identical copies of the file would pass a behaviour check and
    // then drift the first time somebody edited one of them.
    assert.equal(cp[name], ui[name], `cp/session.mjs must re-export the very same ${name}`);
  }
  // Nothing extra on the control plane's side either: an export that exists only there is a piece
  // of the token the relay cannot reach, which is the shape of the bug this move exists to prevent.
  assert.deepEqual(Object.keys(cp).sort(), Object.keys(ui).sort());
});

test("a token minted through one name verifies through the other", () => {
  const now = 1_800_000_000_000;
  const secret = ui.tenantSessionSecret("a master nobody has", "demo");
  const { token } = cp.mintSessionToken({
    sub: "acct_1", email: "demo@titanium.bot", tenant: "demo", host: "demo.titanium.bot",
    iat: now, exp: now + 60_000, jti: "one",
  }, secret, now);
  const verdict = ui.verifySessionToken(token, secret, now + 1000);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.payload.tenant, "demo");
  // And the derivation is the same derivation, which is what makes the relay's key its own.
  assert.equal(cp.tenantSessionSecret("a master nobody has", "demo"), secret);
  assert.notEqual(cp.tenantSessionSecret("a master nobody has", "titanium"), secret);
});

test("ui/session-token.mjs imports node builtins and nothing else", () => {
  // The relay image has no node_modules at all, and the control plane image copies this one file
  // rather than the directory around it. Either an import of a sibling or an import of a package
  // is a container that starts and then throws on the first sign-in.
  const source = readFileSync(path.join(repo, "ui/session-token.mjs"), "utf8");
  const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "it imports something, so the check is measuring a real list");
  for (const specifier of imports) {
    assert.ok(specifier.startsWith("node:"), `${specifier} is not a node builtin`);
  }
});

test("the control plane image copies the file its own session module now imports", () => {
  const dockerfile = readFileSync(path.join(repo, "cp/Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY (\S+) (\S+)/gm)].map((m) => ({ from: m[1], to: m[2] }));
  const token = copied.find((row) => row.from === "ui/session-token.mjs");
  assert.ok(token, "cp/Dockerfile must COPY ui/session-token.mjs");
  // Beside ui/auth.mjs, because cp/session.mjs resolves it as ../ui/session-token.mjs from /app/cp.
  const auth = copied.find((row) => row.from === "ui/auth.mjs");
  assert.ok(auth, "cp/Dockerfile must still COPY ui/auth.mjs");
  assert.equal(path.posix.dirname(token.to), path.posix.dirname(auth.to));
  assert.equal(token.to, "/app/ui/session-token.mjs");

  // The relative import has to resolve inside the image: /app/cp/session.mjs going up one is /app/ui.
  const source = readFileSync(path.join(repo, "cp/session.mjs"), "utf8");
  assert.match(source, /from "\.\.\/ui\/session-token\.mjs"/);
  const resolved = path.posix.resolve(path.posix.dirname("/app/cp/session.mjs"), "../ui/session-token.mjs");
  assert.equal(resolved, token.to);
});

test("the image runs as the uid that owns the tenant files, and the number can be built over", () => {
  // Measured on the R750 on 2026-09-07: `id -u sem` is 1001. The Dockerfile used to say USER node,
  // which is uid 1000 in this base image, believing 1000 was sem. Every tenant directory this
  // service creates would have been owned by a uid that is somebody else on that box.
  const dockerfile = readFileSync(path.join(repo, "cp/Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG UID=1001$/m, "the uid is a build arg so another server can pass its own");
  assert.match(dockerfile, /^ARG GID=1001$/m);
  assert.match(dockerfile, /^USER \$\{UID\}:\$\{GID\}$/m);
  assert.equal(/^USER node$/m.test(dockerfile), false, "USER node is uid 1000, which is not sem on the R750");
});
