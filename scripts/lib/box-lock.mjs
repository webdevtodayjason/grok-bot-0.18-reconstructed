// The shared local-box lock, for gates that must hold it themselves.
//
// scripts/on-box.sh wraps ONE command; a gate that recreates the box has to hold the lock across a
// whole sequence (write, sync, recreate, wait, read back), so it takes the same lock directly. The
// protocol is on-box.sh's, byte for byte, because the two must exclude each other: a directory,
// because mkdir is atomic and macOS ships no flock, with the owner pid inside it.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

export const BOX_LOCK_DIR = process.env.BOX_LOCK_DIR ?? "/tmp/titanbot-box.lock";
const STALE_AGE_S = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// waitMs defaults to 40 minutes, polling every 30 s: the wave's own contract for waiting on a busy
// box rather than stepping on whoever holds it.
export async function acquireBoxLock({ dir = BOX_LOCK_DIR, waitMs = 40 * 60_000, pollMs = 30_000, what = "gate", log = () => {} } = {}) {
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let owner = "";
    try { owner = readFileSync(`${dir}/pid`, "utf8").trim(); } catch {}
    let ageS = 0;
    try { ageS = Math.round((Date.now() - statSync(dir).mtimeMs) / 1000); } catch {}
    // Only a lock whose owner is gone AND is older than the stale window is removed; a live pid
    // holds it however long it takes.
    const ownerGone = owner.length > 0 && !((() => { try { process.kill(Number(owner), 0); return true; } catch (error) { return error?.code === "EPERM"; } })());
    if (ownerGone && ageS > STALE_AGE_S) {
      log(`removing a stale ${dir} (pid ${owner} is gone, ${ageS}s old)`);
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - startedAt >= waitMs) throw new Error(`gave up waiting for ${dir} (held by pid ${owner || "?"}, ${ageS}s)`);
    log(`waiting for ${dir} (held by pid ${owner || "?"}, ${ageS}s)`);
    await sleep(pollMs);
  }
  writeFileSync(`${dir}/pid`, `${process.pid}\n`);
  writeFileSync(`${dir}/cmd`, `${what}\n`);
  const release = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  // Signals as well as a normal return: a gate killed mid-recreate must not leave the box locked.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { release(); process.exit(130); });
  return release;
}
