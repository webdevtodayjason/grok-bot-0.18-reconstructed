// Load ui/machine-room/marketplace-bots.js into this process and hand back its namespace.
//
// The file is an IIFE that attaches window.__marketplaceBots and does nothing else at load: no
// fetch, no timer, no DOM read. So a `new Function` with a stub window is enough to reach the two
// team functions, which is the same trick tests/machine-room-plugins.test.mjs uses on
// gateway-adapter.js. Loading the real file rather than re-implementing the sequence is the whole
// point: the ORDER of the gateway calls is the contract, and a copy of it in a test would pass
// while the console did something else.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function installMarketingTeamModule() {
  const source = readFileSync(path.join(repoRoot, "ui/machine-room/marketplace-bots.js"), "utf8");
  const win = {
    // Nothing in the team path touches these; they exist so a stray reference throws something
    // readable instead of a ReferenceError from inside a template string.
    fetch: async () => { throw new Error("the team path must not reach the network directly"); },
    Element: class {},
    document: null,
    __machineRoomLive: true,
  };
  const fn = new Function("window", `${source}\nreturn window.__marketplaceBots;`);
  const module = fn(win);
  if (module == null || typeof module.importMarketingTeam !== "function") {
    throw new Error("marketplace-bots.js did not export importMarketingTeam");
  }
  return module;
}
