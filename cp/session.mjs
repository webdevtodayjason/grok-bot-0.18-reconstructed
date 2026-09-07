// cp/session.mjs -- the control plane's name for the shared session token.
//
// The code moved to ui/session-token.mjs and this file is a re-export of it. Nothing here is a
// copy: `export * from` gives the same function objects, so there is exactly one mint and one
// verify in the tree and no way for the two sides to drift.
//
// Why it moved. Both halves of tenancy need these bytes: the control plane signs a token when a
// customer signs in, and the relay on that customer's instance verifies it. ui/ is the half that
// ships everywhere -- deploy/r750/sync.sh copies ui/*.mjs to the server, and every tenant's compose
// mounts that directory into the relay read only -- while cp/ only ever exists inside the control
// plane image. So a relay could not import cp/session.mjs, and the alternative to moving the file
// was a second copy of the verifier living in ui/. Two verifiers that disagree by one line look
// exactly like a customer typing the wrong password, and nothing in the logs says otherwise.
//
// This file stays because cp/server.mjs, cp/store.mjs, cp/provision.mjs and cp/cli.mjs import from
// it, the image copies cp/ as a unit, and "the control plane's session module" is a real thing to
// name. See ui/session-token.mjs for the token shape, the per-tenant key derivation and the rules.
export {
  SESSION_VERSION,
  SESSION_TTL_MS,
  base64urlDecode,
  base64urlEncode,
  mintSessionToken,
  tenantOfUnverifiedToken,
  tenantSessionSecret,
  verifySessionToken,
} from "../ui/session-token.mjs";
