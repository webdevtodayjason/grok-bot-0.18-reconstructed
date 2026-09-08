// BROWSER-1. The browser driver reaches a box one way: deploy/r750/sync.sh copies
// runtime/browser-driver/ into $ROOT/runtime, and every box bind-mounts that whole directory
// read-only at /opt/titanbot-runtime. So a module added to the driver that sync.sh does not carry
// is a box whose browser tools fail at import, on the first page a person asks for and not before.
//
// This is the same shape as the relay-module pin next door, for the same reason it exists: a
// hand-kept list forgot two of ui/*.mjs and would have taken the R750 relay down at import.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driverDirectory = path.join(repo, "runtime/browser-driver");
const script = () => readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8");

test("sync.sh ships the whole browser driver directory, and cleans up what an older ship left", () => {
  const source = script();
  assert.match(
    source,
    /rsync -a --delete "\$REPO\/runtime\/browser-driver\/" "\$HOST:\$ROOT\/runtime\/browser-driver\/"/,
    "the driver ships as a directory, so a file added to it needs no edit here",
  );
  assert.match(source, /say "runtime\/host-main\.cjs.*runtime\/browser-driver\/"/, "the ship says what it shipped");
});

test("every module the driver imports is inside the directory that ships", () => {
  const modules = readdirSync(driverDirectory).filter((name) => name.endsWith(".mjs"));
  assert.ok(modules.includes("cli.mjs"), "cli.mjs is what the gate and the box call");
  assert.ok(modules.includes("driver.mjs"), "driver.mjs is the browser itself");

  for (const name of modules) {
    const body = readFileSync(path.join(driverDirectory, name), "utf8");
    for (const match of body.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.ok(
        specifier.startsWith("./"),
        `${name} imports "${specifier}"; the driver runs from a read-only mount with no node_modules beside it, so every import is node: or a sibling file`,
      );
      const sibling = specifier.slice(2);
      assert.ok(modules.includes(sibling), `${name} imports ./${sibling}, which has to be in the directory that ships`);
    }
    assert.ok(!/\brequire\(\s*"(?!node:)/.test(body), `${name} must not require a package either`);
  }
});

test("install.sh refuses a box whose runtime mount has no driver in it", () => {
  const installer = readFileSync(path.join(repo, "deploy/r750/install.sh"), "utf8");
  assert.match(
    installer,
    /\[ -f "\$ROOT\/runtime\/browser-driver\/cli\.mjs" \] \|\| die/,
    "the guard sits beside the ones for the bundle and the exec daemon",
  );
  // And the entry point Titan's own tools run, which is the one a person notices when it is gone:
  // browser_open on a box with no host-op.mjs cannot say anything better than "no such file".
  assert.match(
    installer,
    /\[ -f "\$ROOT\/runtime\/browser-driver\/host-op\.mjs" \] \|\| die/,
    "the browser tools run host-op.mjs for every page they open",
  );
});

test("the mount that carries the driver into a box is the one every box already has", () => {
  // No new bind mount: the driver rides the runtime directory the bundle already rides. If any of
  // these three stop mounting the directory, the ship above silently stops arriving.
  const mounts = [
    ["deploy/r750/install.sh", /src=\$ROOT\/runtime,dst=\/opt\/titanbot-runtime,readonly/],
    ["deploy/coolify/box.compose.yml", /\/home\/sem\/titanbot\/runtime:\/opt\/titanbot-runtime:ro/],
    ["deploy/coolify/docker-compose.yml", /\/home\/sem\/titanbot\/runtime:\/opt\/titanbot-runtime:ro/],
  ];
  for (const [file, pattern] of mounts) {
    assert.match(readFileSync(path.join(repo, file), "utf8"), pattern, `${file} mounts the runtime directory into the box`);
  }
});

test("the driver stays dependency free, which is the reason it can ship this way", () => {
  const packaged = readdirSync(driverDirectory);
  assert.ok(!packaged.includes("node_modules"), "nothing is vendored: playwright-core would be 12 MB to open one loopback socket");
  assert.ok(!packaged.includes("package.json"), "there is nothing to install, so there is nothing to declare");
});
