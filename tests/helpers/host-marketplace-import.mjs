// The host's catalog import, bundled once for whatever suite needs it.
//
// TITAN-CATALOG-1 moved the Add sequence out of ui/machine-room/bot-setup.js and into
// source/host/extensions/marketplace/marketplace-bot-import.ts, so the console's press and Titan's
// request are two doors onto one import. Two suites need to reach that module: the host suite that
// pins its order, and tests/community-bots.test.mjs, whose case plans a SHIPPED catalog row's apps
// and used to reach the console function that no longer exists.
//
// It is a helper rather than a copy in each of them because the bundling is fiddly — esbuild to
// CJS with the three native modules left external, staged inside the tree so `require` can resolve
// them — and because bundling the same 20 MB module twice in one run is the kind of thing that
// makes people stop running the suite.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Staged in the tree rather than os.tmpdir() so `require` walks up to this checkout's node_modules
// for the three modules the bundle leaves external. `.tmp-*` is ignored by git.
const stage = mkdtempSync(path.join(repoRoot, ".tmp-host-marketplace-"));
process.on("exit", () => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* going away anyway */ } });
const require_ = createRequire(import.meta.url);

async function bundle(entry, name) {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
}

/** The import module: the verb, the sequence, and the pure readers the plan is built from. */
export const hostMarketplaceImport = await bundle(
  "source/host/extensions/marketplace/marketplace-bot-import.ts",
  "marketplace-bot-import.cjs",
);

/** The catalog itself, so a case can be driven off a real row rather than a fixture. */
export const marketplaceCatalog = await bundle(
  "source/shared/marketplace/catalog.ts",
  "catalog.cjs",
);
