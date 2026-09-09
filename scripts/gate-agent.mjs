// scripts/gate-agent.mjs -- the name a verification gate says at somebody's front door.
//
// SIGNIN-1. Jason, 2026-09-09 11:43, holding two screenshots of the Sign-in attempts panel: his own
// address marked "Attack", 101 tries, 58 locked out, 23 different passwords, one of the accounts his
// own. Every one of those bursts was this repository's own deploy gate doing what it is written to
// do -- two wrong instance passwords, then seven more until the throttle answers, because the rule
// it measures is the lockout itself. The panel could not tell that from a stranger, and it could not
// because the only thing the rows carried about the caller was a user agent reading "node", which is
// what node's fetch sends when nobody sets one.
//
// So a gate says its own name at the door. The relay has recorded the user agent on every attempt
// since ADMIN-1 (ui/login-ledger.mjs clips it to 120 characters and ui/server.mjs fills it from the
// request), so on this side the whole change is one header.
//
// WHAT THIS HEADER IS WORTH, said out loud, because it would be easy to read it as more than it is.
// A user agent is a string a stranger writes. Sending "titanbot-gate/verify-deploy" is a HINT and
// never a credential, and the prefix alone can never buy an attacker silence. The panel's rule is
// deliberately narrower than this header: a row counts as a gate's own only when the address it
// arrived from ALSO signed in successfully as an operator or a super admin inside the same hour,
// which is the half nobody outside can forge. docs/ADMIN.md, "Telling a gate from an attacker",
// carries the whole rule. Nothing here decides anything; it only makes the honest case nameable.
//
// The name is derived from the calling script's own filename rather than typed into it, so a gate
// written next year gets this by importing the file rather than by remembering a string.
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prefix, in one place. The panel matches on it and the documents quote it, so it is a constant
 * rather than a literal in five scripts.
 */
export const GATE_AGENT_PREFIX = "titanbot-gate/";

/**
 * The user agent for the gate whose `import.meta.url` is passed in.
 *
 *   gateUserAgent(import.meta.url)  ->  "titanbot-gate/verify-deploy"
 *
 * The name is the basename with its extension off. Anything outside letters, digits, dot, dash and
 * underscore becomes a dash: a header value with a newline or a control character in it is a
 * request-splitting shape, and a filename is not somewhere to start trusting bytes just because we
 * wrote it. A caller that passes nothing recognisable gets "titanbot-gate/unknown" rather than a
 * header ending in a slash, because a name that is empty reads on the panel as a field that failed.
 */
export function gateUserAgent(from = "") {
  const raw = String(from ?? "");
  const file = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
  const name = path.basename(file).replace(/\.[cm]?js$/i, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return `${GATE_AGENT_PREFIX}${name.length > 0 ? name : "unknown"}`;
}
