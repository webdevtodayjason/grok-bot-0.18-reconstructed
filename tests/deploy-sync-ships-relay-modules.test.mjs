import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// SHIP-3. deploy/r750/sync.sh shipped a hand-kept list of relay files, and two modules that
// ui/server.mjs imports (vnc-bridge.mjs, job-bus-edge.mjs) were added to ui/ without being added to
// the list: shipping server.mjs alone would have taken the R750 relay down at import. The script
// now ships every ui/*.mjs, and this holds it to that.
test("sync.sh ships every module the relay imports, and never the three secret json files", () => {
  const script = readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8");
  assert.match(script, /rsync -a "\$REPO"\/ui\/\*\.mjs /, "the relay's modules ship by glob, not by a list that forgets");
  const imported = [...readFileSync(path.join(repo, "ui/server.mjs"), "utf8").matchAll(/from "\.\/([A-Za-z0-9_-]+\.mjs)"/g)].map((m) => m[1]);
  const present = readdirSync(path.join(repo, "ui")).filter((f) => f.endsWith(".mjs"));
  for (const mod of imported) assert.ok(present.includes(mod), `${mod} is imported by ui/server.mjs and must exist in ui/`);
  assert.ok(imported.length >= 3, `server.mjs imports ${imported.length} sibling modules; the glob covers them all`);
  for (const secret of ["auth.json", "endpoints.json", "subscriptions.json"]) assert.ok(!script.includes(`ui/${secret}"`), `${secret} is never named as a ship source`);
  assert.match(script, /imports \.\/\$mod but/, "the sync proves each import is on the server before a restart");
});

// TENANT-1. docs/TENANCY.md section 9 is the deploy: run sync.sh, then build the control plane
// image on the server from $ROOT with cp/Dockerfile. Nothing shipped cp/ or the compose files, so
// that build had nothing to build from and the documented first step could not run.
test("sync.sh ships the control plane and the two compose files the image is built from", () => {
  const script = readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8");
  assert.match(script, /rsync -a "\$REPO"\/cp\/\*\.mjs /, "cp's modules ship by glob, not by a list that forgets");
  assert.match(script, /"\$REPO\/cp\/Dockerfile"/, "the image is built from this file on the server");

  // Everything cp/Dockerfile copies has to be on the server, because the build context there is
  // $ROOT. Read out of the Dockerfile rather than listed here, so a COPY added later is caught.
  const dockerfile = readFileSync(path.join(repo, "cp/Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY (\S+) /gm)].map((m) => m[1]);
  assert.ok(copied.length >= 4, `cp/Dockerfile copies ${copied.length} things`);
  for (const source of copied) {
    // Either the file by name or a glob over its directory with its extension. Both are ways
    // sync.sh already ships things, and both put the file where the build context expects it.
    const shipped = source.endsWith("/")
      ? new RegExp(`/${source}\\*`)
      : new RegExp(`/${path.posix.dirname(source)}/(?:${path.posix.basename(source).replace(/[.]/g, "\\.")}|\\*${path.posix.extname(source).replace(/[.]/g, "\\.")})`);
    assert.match(script, shipped, `cp/Dockerfile copies ${source}, so sync.sh has to put it on the server`);
  }

  // The tenant template and the control plane's own resource file.
  assert.match(script, /deploy\/coolify\/docker-compose\.yml"/, "the template every tenant is rendered from ships");
  assert.match(script, /deploy\/coolify\/control-plane\.compose\.yml"/, "the operator pastes this one into Coolify");

  // And never the directory, because cp/.data is the sqlite store with the account rows in it.
  assert.equal(script.includes('"$REPO/cp/"'), false, "a directory copy would carry cp/.data to the server");
});
