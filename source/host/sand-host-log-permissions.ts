import { constants, fchmodSync, fstatSync } from "node:fs";

/**
 * The host's own stdout is its log. Inside the box the supervisor opens /tmp/sand-host.log as root
 * with the default umask, so it lands world-readable, while every agent shell runs as an
 * unprivileged user in the same container: one `cat` and an agent reads every line any host
 * subsystem has ever written -- prompts, tool arguments, the trace lines this build added.
 *
 * Nothing legitimate reads that file as anyone but the owner. The Electron dev controls and every
 * verification script reach it through `docker exec`, which is root. So the host narrows the mode
 * of the file it is writing into, once, at boot. `fchmod` on the descriptor rather than a chmod by
 * path, because the path is the supervisor's business and a name can be relinked underneath us.
 *
 * Anything that is not a plain file -- a terminal, a pipe, the desktop build's console -- is left
 * exactly as it is, and a failure is not worth a word: a host that cannot tighten its log still has
 * to start.
 */
export const SAND_HOST_LOG_MODE = 0o600;

export function narrowSandHostLogPermissions(descriptors: readonly number[] = [1, 2]): void {
  const alreadyDone = new Set<string>();
  for (const fd of descriptors) {
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) continue;
      const identity = `${stats.dev}:${stats.ino}`;
      if (alreadyDone.has(identity)) continue;
      alreadyDone.add(identity);
      const readableByOthers = (stats.mode & (constants.S_IRGRP | constants.S_IROTH)) !== 0;
      const writableByOthers = (stats.mode & (constants.S_IWGRP | constants.S_IWOTH)) !== 0;
      if (!readableByOthers && !writableByOthers) continue;
      fchmodSync(fd, SAND_HOST_LOG_MODE);
    } catch { /* not our file to tighten, and not a reason to fail a boot */ }
  }
}
