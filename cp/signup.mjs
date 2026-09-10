// cp/signup.mjs -- the sequence that turns a company into a customer, as a function.
//
// ADMIN-2. Jason, 2026-09-09 11:43: "if I was going to onboard a new client, would that be
// something I would do from this console or is this console merely reporting?" Adding a client was
// a CLI line on the server (`node cp/cli.mjs signup add`), and the Clients panel could stop, start,
// restart, provision, set a ceiling and move a workspace onto a plan model -- everything except the
// first step of onboarding, which is the one step that has to happen before any of the rest of the
// panel means anything.
//
// WHY THIS IS ITS OWN FILE RATHER THAN A CALL INTO cp/server.mjs. The sequence lives inside
// handleSignup, which is an HTTP handler: it reads a request, counts a failure against a rate
// limiter and writes a response. The console needs the same eight steps and none of those three
// things, and cp/server.mjs is outside this wave's ownership and is being edited by another wave
// right now. So the steps are here, the console calls this, and handleSignup is untouched.
//
// THE COST IS THAT THE SEQUENCE EXISTS TWICE, and the control on it is in this file: every refusal
// is a named constant exported from here, and tests/cp-signup.test.mjs reads cp/server.mjs's own
// source and asserts each sentence is in it word for word. The two doors cannot drift into telling
// a person two different things about the same refusal without a test going red. ADMIN-2b is filed
// with the rewiring -- handleSignup calling this -- as its next action.
//
// THE ONE REAL DIFFERENCE from the customer's door: nobody is at a keyboard typing a password, so
// this GENERATES one, hands it back exactly once, and stores nothing but a scrypt hash of it. It is
// the same primitive the reset-password action already uses, for the same reason.

import { randomBytes } from "node:crypto";

import {
  NEW_TENANTS_BLOCKED,
  consoleHost,
  deriveSlug,
  provisionTenant,
} from "./provision.mjs";
import { normalizeEmail } from "./store.mjs";

// 18 random bytes in base64url is 24 characters and about 144 bits. Shown once, stored as a scrypt
// hash like every other password here, and there is no route anywhere that can be asked for it
// again.
export const TEMP_PASSWORD_BYTES = 18;

// ---- the refusals, word for word with the customer's own door ---------------------------------
//
// These are the strings cp/server.mjs's handleSignup answers with. They are constants here so a
// test can hold both doors to the same words, and so a change to one of them is a change somebody
// makes on purpose in one place.

export const SIGNUP_BAD_EMAIL = "Send a real email address.";
export const SIGNUP_BAD_COMPANY_EMPTY = "Send the name of your company.";
export const SIGNUP_DUPLICATE_EMAIL = "That email address already has an account. Sign in instead.";
export const SIGNUP_BAD_COMPANY =
  "That company name has no letters or numbers in it, so there is nothing to name the workspace after. Send a different one.";
export const SIGNUP_NEW_TENANTS_OFF = NEW_TENANTS_BLOCKED;
export const SIGNUP_PROVISIONING_UNFINISHED =
  "Your account is set up and your workspace is not finished yet. You can sign in, and your workspace will be there once it comes up.";

/**
 * One company, added.
 *
 * The same eight steps handleSignup runs for an operator, in the same order, with the same
 * refusals: normalise the email, refuse a duplicate, derive the workspace name from the company
 * name against everything taken AND everything retired, refuse a nameless company, refuse when new
 * workspaces are off, write the workspace row, write the account (taking the workspace row back out
 * if the account throws, so a name is not spent on a customer that does not exist), then build the
 * box.
 *
 * A PROVISIONING FAILURE KEEPS THE ACCOUNT. That is deliberate and it is what the customer's door
 * does too: they can sign in, the workspace finishes later, and one retry from the Clients panel
 * picks up where it stopped. Throwing the account away would turn a slow image pull into a customer
 * who has to be created again.
 *
 * Answers `{ ok: false, status, error, message }` for a refusal and `{ ok: true, ... }` otherwise.
 * It throws nothing a caller has to catch except a store failure, which is a broken database and
 * not a refusal.
 */
export async function addClient({
  store,
  config,
  fetchImpl = globalThis.fetch,
  probeImpl = undefined,
  email: wanted,
  company: rawCompany,
  name = "",
  bytes = randomBytes,
  // ONBOARD-2. When false this stops after the two rows exist and does NOT build the box, so the
  // caller can answer at once and run the build as a job behind a polled card.
  //
  // WHY THE DEFAULT IS TRUE AND STAYS TRUE. Every existing caller -- cp/server.mjs's handleSignup
  // included, which is not edited -- gets exactly today's behaviour. The refusals above are the
  // whole of what this option can change about what a person is told, and it changes none of them:
  // they are all decided before the first write either way.
  awaitProvisioning = true,
}) {
  const email = normalizeEmail(wanted);
  const company = String(rawCompany ?? "").trim();
  if (!email.includes("@") || email.length < 3) {
    return { ok: false, status: 400, error: "bad_request", message: SIGNUP_BAD_EMAIL };
  }
  if (company.length === 0) {
    return { ok: false, status: 400, error: "bad_request", message: SIGNUP_BAD_COMPANY_EMPTY };
  }
  if (store.getAccountByEmail(email) != null) {
    return { ok: false, status: 409, error: "duplicate_email", message: SIGNUP_DUPLICATE_EMAIL };
  }

  // Taken means taken NOW or still spoken for. A workspace that was removed while sign-ins still
  // pointed at it keeps its name out of circulation: handing that name to a different company
  // would make the previous customer's sign-ins resolve to the new company's box, with full access
  // to it.
  const slug = deriveSlug(company, (candidate) => store.getTenant(candidate) != null || store.isSlugRetired(candidate));
  if (slug == null) {
    return { ok: false, status: 400, error: "bad_company", message: SIGNUP_BAD_COMPANY };
  }
  if (!config.allowNewTenants) {
    return { ok: false, status: 409, error: "new_tenants_off", message: SIGNUP_NEW_TENANTS_OFF };
  }

  // Generated here and returned exactly once. It is never written to a ledger row, never logged and
  // never in a URL: cp/admin.mjs puts it in one response body and forgets it.
  const temporaryPassword = bytes(TEMP_PASSWORD_BYTES).toString("base64url");
  const host = consoleHost(config);
  store.createTenant({ slug, name: company, host, status: "provisioning", ownerEmail: email });
  let account;
  try {
    account = store.createAccount({ email, password: temporaryPassword, name: String(name ?? ""), tenant: slug });
  } catch (error) {
    // The workspace row was written a line ago and nobody owns it, so it comes back out rather than
    // sitting in the ledger as a name a later customer cannot have.
    store.deleteTenant(slug);
    if (error?.code === "duplicate_email") {
      return { ok: false, status: 409, error: "duplicate_email", message: SIGNUP_DUPLICATE_EMAIL };
    }
    throw error;
  }

  const signIn = `https://${host}`;

  // ONBOARD-2. The caller is running the build as a job, so this hands back the account and the
  // password NOW. state is "building" and boxReady is false, which is exactly what is true: the
  // workspace row exists, nothing has been built yet, and the person can already sign in.
  if (!awaitProvisioning) {
    return {
      ok: true,
      slug,
      account,
      tenant: store.getTenant(slug),
      temporaryPassword,
      signIn,
      state: "building",
      boxReady: false,
      boxNote: "The workspace was created and its computer is being built now.",
      provisioning: { ok: true, step: "", why: "", awaited: false },
    };
  }

  const result = await provisionTenant({ store, config, slug, name: company, fetchImpl, probeImpl });
  if (!result.ok) {
    return {
      ok: true,
      slug,
      account,
      tenant: store.getTenant(slug),
      temporaryPassword,
      signIn,
      state: "failed",
      boxReady: false,
      // The customer's own door's sentence, so the two doors say the same thing about the same
      // half-built workspace, plus the step it stopped at, which only an operator can act on.
      boxNote: SIGNUP_PROVISIONING_UNFINISHED,
      provisioning: { ok: false, step: result.step ?? "", why: String(result.error ?? "") },
    };
  }
  return {
    ok: true,
    slug,
    account,
    tenant: result.tenant,
    temporaryPassword,
    signIn,
    state: result.boxReady ? "running" : "building",
    boxReady: result.boxReady === true,
    boxNote: result.boxNote,
    provisioning: { ok: true, step: "", why: "" },
  };
}
