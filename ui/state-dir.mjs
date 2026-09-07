// ui/state-dir.mjs -- where the relay's own writable files live.
//
// The relay writes five files: auth.json, endpoints.json, subscriptions.json, mail.json and
// mail-inbox.jsonl. Every one of them used to default to the directory this code is in, which was
// right for exactly one deployment: the one where ui/ belongs to the only relay on the machine.
//
// On a multi-tenant server ui/ is a shared release directory. Every tenant's container mounts the
// same host path, so those five files would be five files every customer writes over. Two tenants
// would share one password, one endpoint list and one mail inbox, and the mount could never be made
// read only, which is the thing that keeps a customer from editing the code the other customers
// run. SAND_UI_STATE_DIR is the answer: point it at a directory that belongs to this instance and
// the five files come out of there instead.
//
// Unset, nothing moves. That is deliberate and it is the whole compatibility story: Jason's own
// instance and every developer Mac keep writing beside the code exactly as they did, and a deploy
// that forgets this variable behaves the way it did yesterday rather than losing its password file.
//
// The per-file env overrides still win over both. They are older than this and they are what the
// tests and the gates set to work in a temp directory, so the order is: the file's own variable,
// then SAND_UI_STATE_DIR, then beside the code.
//
// The job bus token is the one writable file this does NOT move, because it was never beside the
// code: it lives in the first SAND_PROFILE_DIRS entry, which is already the tenant's own profile
// mount. See ui/job-bus-edge.mjs, jobBusTokenFile.
//
// Nothing here imports anything outside node builtins, because the relay image has no node_modules.
import path from "node:path";

export const STATE_DIR_ENV = "SAND_UI_STATE_DIR";

// The configured directory, or "" when there is none. Whitespace is trimmed because this arrives
// from a compose file, where a stray space is easy to type and impossible to see.
export function stateDir(env = process.env) {
  return String(env?.[STATE_DIR_ENV] ?? "").trim();
}

// Where a relay file called `name` goes: the state directory when there is one, otherwise `here`,
// which every caller passes as its own directory. A relative SAND_UI_STATE_DIR is resolved against
// the process's working directory, the same as any other relative path in a compose file.
export function stateFile(name, here, env = process.env) {
  const dir = stateDir(env);
  return dir.length > 0 ? path.resolve(dir, name) : path.join(here, name);
}
