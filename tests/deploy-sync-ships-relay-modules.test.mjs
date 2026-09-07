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
  // Every file by name, or by a glob over its directory with its extension, or by a directory
  // rsync. All three are ways sync.sh already ships things and all three put the file where the
  // build context expects it.
  //
  // ADMIN-1 widened this. `COPY cp/ /app/cp/` used to be satisfied by seeing "cp/*" anywhere in the
  // script, which `rsync -a "$REPO"/cp/*.mjs` matches -- so cp/admin/, the super admin console's
  // three files, passed this test while shipping nothing. The image then built, the service started,
  // and GET /admin answered 500. So a directory COPY is now expanded and every file under it is
  // checked on its own name.
  const shipsFile = (relative) => {
    const dir = path.posix.dirname(relative);
    const base = path.posix.basename(relative);
    const escaped = base.replace(/[.]/g, "\\.");
    const extension = path.posix.extname(relative).replace(/[.]/g, "\\.");
    const byName = new RegExp(`/${dir}/${escaped}`);
    const byGlob = extension.length > 0 ? new RegExp(`/${dir}/\\*${extension}`) : null;
    // rsync -a "$REPO/cp/admin/" "$HOST:...": the whole directory, trailing slash and all.
    const byDirectory = new RegExp(`"\\$REPO/${dir}/"`);
    return byName.test(script) || (byGlob != null && byGlob.test(script)) || byDirectory.test(script);
  };
  const filesUnder = (relative) => {
    const full = path.join(repo, relative);
    const out = [];
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      // cp/.data is the local sqlite store and is deliberately never shipped, which the last
      // assertion in this test is about. It is not part of the image either: the Dockerfile's
      // build context on the server has no such directory.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { out.push(...filesUnder(next)); continue; }
      out.push(next);
    }
    return out;
  };
  for (const source of copied) {
    const targets = source.endsWith("/") ? filesUnder(source.replace(/\/$/, "")) : [source];
    assert.ok(targets.length > 0, `cp/Dockerfile copies ${source} and there is nothing there`);
    for (const target of targets) {
      assert.ok(shipsFile(target), `cp/Dockerfile copies ${source}, so sync.sh has to put ${target} on the server`);
    }
  }

  // Named outright as well, because this is the one that was missed and a regression here is a
  // console that answers 500 rather than a build that fails.
  assert.match(script, /rsync -a --delete "\$REPO\/cp\/admin\/"/, "the super admin console's three files ship as a directory");
  for (const page of ["index.html", "admin.css", "admin.js"]) {
    assert.ok(readdirSync(path.join(repo, "cp/admin")).includes(page), `cp/admin/${page} is what the control plane serves at /admin`);
  }

  // The tenant template and the control plane's own resource file.
  assert.match(script, /deploy\/coolify\/docker-compose\.yml"/, "the template every tenant is rendered from ships");
  assert.match(script, /deploy\/coolify\/control-plane\.compose\.yml"/, "the operator pastes this one into Coolify");

  // And never the directory, because cp/.data is the sqlite store with the account rows in it.
  assert.equal(script.includes('"$REPO/cp/"'), false, "a directory copy would carry cp/.data to the server");
});
