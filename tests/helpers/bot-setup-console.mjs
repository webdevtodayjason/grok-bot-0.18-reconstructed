// Load ui/machine-room/bot-setup.js into this process and hand back its namespace.
//
// The file is an IIFE that attaches window.__botSetup and does nothing else at load: no fetch, no
// timer, no DOM read. So a `new Function` with a stub window reaches the whole setup sequence,
// which is the same trick tests/helpers/marketing-team-console.mjs uses on marketplace-bots.js.
// Loading the real file rather than re-implementing the sequence is the point: the ORDER of the
// gateway calls IS the contract, and a copy of it in a test would pass while the console did
// something else.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `withPage` loads marketplace-bots.js into the same stub window first, so the identity
 * composition really is the one the console uses rather than the local copy standing in for it.
 */
export function installBotSetupModule({ withPage = false } = {}) {
  const win = {
    fetch: async () => { throw new Error("the setup path must not reach the network directly"); },
    Element: class {},
    document: null,
    __machineRoomLive: true,
  };
  if (withPage) {
    const page = readFileSync(path.join(repoRoot, "ui/machine-room/marketplace-bots.js"), "utf8");
    new Function("window", page)(win);
  }
  const source = readFileSync(path.join(repoRoot, "ui/machine-room/bot-setup.js"), "utf8");
  const module = new Function("window", `${source}\nreturn window.__botSetup;`)(win);
  if (module == null || typeof module.setUpBot !== "function") {
    throw new Error("bot-setup.js did not export setUpBot");
  }
  return { module, window: win };
}
