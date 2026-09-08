#!/usr/bin/env node
// build-host.mjs -- build the patched host bundle from this tree.
//   node scripts/build-host.mjs [--out <dir>] [--deploy]
// Writes <out>/dist/host/host-main.cjs (default out: .cache/hostbuild, gitignored). With --deploy,
// copies it over .cache/patched-host/host-main.cjs, which the box container bind-mounts read-only,
// and restarts the container named by SAND_BOX_CONTAINER (default grok-bot-local-vm).
// This used to live at /tmp/dobuild.mjs on one Mac, which a reboot would have erased.
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { buildProductionHostIfSupplied } from "./host-production-activation.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const repo = resolve(dirname(new URL(import.meta.url).pathname), "..");
const outputRoot = resolve(flag("--out") ?? join(repo, ".cache", "hostbuild"));
mkdirSync(outputRoot, { recursive: true });
const r = await buildProductionHostIfSupplied({ outputRoot });
console.log(r.status, "clean=" + r.clean, r.blocker ?? "", join(outputRoot, "dist/host/host-main.cjs"));
if (r.clean !== true) process.exit(1);
if (args.includes("--deploy")) {
  const target = join(repo, ".cache", "patched-host", "host-main.cjs");
  copyFileSync(join(outputRoot, "dist/host/host-main.cjs"), target);
  // BROWSER-1. The bundle is not the only thing in the runtime mount any more. Titan's browser
  // driver is plain .mjs with no build step, and the box reads it from the same directory the
  // bundle sits in, so a --deploy that stages only the bundle leaves the local box driving an old
  // driver, or none. deploy/r750/sync.sh does the same thing for the server with an rsync; this is
  // its local half, and the in-box path is identical on both (/opt/titanbot-runtime/browser-driver).
  const driverSource = join(repo, "runtime", "browser-driver");
  const driverTarget = join(repo, ".cache", "patched-host", "browser-driver");
  rmSync(driverTarget, { recursive: true, force: true });
  cpSync(driverSource, driverTarget, { recursive: true });
  const container = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
  execFileSync("docker", ["restart", container], { stdio: "inherit" });
  console.log(`deployed to ${target}, staged the browser driver at ${driverTarget}, and restarted ${container}`);
}
