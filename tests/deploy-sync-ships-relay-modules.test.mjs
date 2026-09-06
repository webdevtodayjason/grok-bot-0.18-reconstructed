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
