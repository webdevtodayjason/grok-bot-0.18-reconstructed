# ONBOARD-5: a sign-in link that is spent when it is clicked, and that an operator can take back

Built 2026-09-13 on branch `night-onboard35`. Covers ONBOARD-5 whole and the **link half** of
ONBOARD-3. Measured on this Mac (Darwin 25.6.0, node v22.23.1). **Nothing ran on the R750.**

## Read this first: one link mailed before tonight still works, and after this ships none do

Every sign-in link minted before this change carries a `jti` that nothing wrote down. The relay now
asks the control plane whether a link's id is still good, an id with no row answers `unknown`, and an
`unknown` link is refused. So the moment this is live:

- Any link in any customer's inbox from before the deploy stops working. They meet *That sign-in link
  is not on record here, so it cannot be used. Ask for a new one.*
- The temporary password in the same mail is unaffected, and so is every session anybody is already
  signed in on.
- The recovery is the same button it has always been: **Copy a sign-in link** on the Clients panel, or
  **Send again**.

This is deliberate, not an oversight. Accepting an unrecorded link is exactly the credential the row
exists to retire, so there is no grandfather clause and no flag to turn one on.

## The fault, as measured 2026-09-10

A sign-in link was a stateless bearer credential in a URL. `ui/server.mjs`'s `handleSso` verified the
signature and the expiry against that workspace's derived key and asked nobody anything else. So one
link worked as many times as it was clicked for its whole 24 hours, and the only way to cancel one was
to rotate `CP_SESSION_SECRET`, which signs the entire fleet out. A link that reached the wrong inbox, a
link in the history of a shared browser and a link a mail gateway logged were all the same thing: a
standing key to somebody's console that nobody could take back.

ONBOARD-2 bounded that rather than removing it. The 24 hours was a ceiling and not a target, the link
went into no send row, no audit row, no log line and no screenshot, click tracking was off for
titanium.bot so a scanner would not fetch it, and the welcome had exactly one recipient with no bcc
anywhere in the path. All of that still holds. None of it made a leaked link cancellable.

## What was built

**The id is the token's own `jti`.** `ui/session-token.mjs` has always required that claim and fills it
with a `randomUUID`. So the token format did not change and **that file was not touched**, which matters
because it is the one file the relay and the control plane share: a change there is a change to every
session in the fleet.

**One table.** `cp/store.mjs` gains `sign_in_links`: the id, the workspace, the account, the address,
who minted it, why, when it was minted, when it expires, whether it is single use, the first use, the
last use, where it was used from, how many uses, and the revocation with its actor. **It holds no token
in any field.** A table of live credentials is the thing this row exists to retire. An id cancels a
link; it can never use one.

**Single use is one SQL statement.** `claimSignInLink` marks the link used in the same `UPDATE` whose
`WHERE` decides whether it may be used. Two clicks a millisecond apart cannot both be allowed. A
read-then-write would let both through, which on a link that reached the wrong inbox is the original
fault still in place wearing a revocation table as a disguise.

**Both minters record first, and refuse to mint if they cannot.** `cp/onboard.mjs`'s `mintSignInLink`
throws without a store that can write. `cp/welcome.mjs`'s answers `WELCOME_LINK_NOT_RECORDED` and
**sends no mail at all**. A link this service has no row for is refused at the door, so handing one out
would give a customer a credential that can never work with nobody able to say why. The two are
separate call sites on one store method rather than one calling the other, because each has its own
refusal vocabulary and a translation layer between them is how a refusal goes missing.

**The relay asks once per click.** `POST /v1/relay/sign-in-links/claim` with `{id, tenant, from}` behind
`CP_RELAY_TOKEN`, the same credential and the same shape as the registry read. A refusal is a **200 with
a verdict**, because the question was answered; a 400 is reserved for a body with no id or no workspace,
which is a caller bug and not a verdict. A token that did **not** verify is never asked about, so an
unauthenticated route cannot be turned into an amplifier pointed at the control plane.

**A relay that cannot ask refuses the click.** 503, not 401, and in words that point at a door that
still works: *That sign-in link could not be checked just now, so it was not used. Try it again in a
minute, or sign in with your email and password.* The relay cannot know whether a link has been used,
and the safe reading of "I do not know" about a credential is no. An outage costs the link door and
nothing else: the registry's last good answer still serves every workspace, every session already minted
is untouched, and the instance password is unaffected.

**Four refusals, each with its own sentence and its own ledger reason.**

| what happened | what the person reads | what the ledger row says |
| --- | --- | --- |
| the link was already clicked | That sign-in link has already been used. Ask for a new one. | that sign-in link had already been used |
| the console cancelled it | That sign-in link was cancelled. Ask for a new one. | that sign-in link was cancelled |
| its day ran out | That sign-in link has expired. Ask for a new one. | that sign-in link had expired |
| nothing recorded it | That sign-in link is not on record here, so it cannot be used. Ask for a new one. | that sign-in link is not on record |
| the control plane could not be asked | That sign-in link could not be checked just now, so it was not used. Try it again in a minute, or sign in with your email and password. | the control plane could not be asked about that sign-in link |

`ui/login-ledger.mjs` gains one field, `reason`, capped at the control plane's own 200 characters so the
merged Sign-in attempts list cannot differ on the tail of a sentence. The two password doors leave it
empty on purpose: the password check, the lockout and the disabled account are all decided on the
control plane and the sentence is written there with them.

**The console.** A **Sign-in links** row sits under the welcome row on every client card, listing every
link a click would still open, with who it is for, when it expires, who minted it, and a **Revoke**
beside each. It reads *none live* when there are none, and says so in words when this control plane keeps
no record, because an empty list and "I cannot tell" must never look the same. `GET .../sign-in-links`
(`?all=1` for the history) and `POST .../sign-in-link/revoke` back it, and both are on the super-admin
guard's net.

That row exists because of a fact nothing else on the panel shows: a welcome plus two presses of **Copy
a sign-in link** leave **three** live links, and minting a replacement has never cancelled the previous
one.

**What Revoke ends, and what it does not.** A link is dead a moment after the press, with no cache to
wait out, because the question is asked on every click. A person who has **already** signed in on that
link keeps the session they were given: that is a session and not a link, and it ends on the relay's own
twelve-hour clock or when the master is rotated.

## ONBOARD-3, the link half

The welcome's link is now minted by the same recorded, single-use, revocable mechanism the operator's
button uses, so the mail and the panel hand out the same kind of thing and neither can hand out a link
nobody can cancel. A leaked welcome is now worth one sign-in that the operator can also cancel, rather
than a day of them.

**What is still wrong, and still owned.** There is still no customer-facing set-your-own-password door
anywhere in the product, `POST /v1/accounts/{id}/password` is still behind `requireAdmin`, and a
link-only mail would still lock a customer out at hour 25 with the operator as the only recovery. So the
welcome still carries the temporary password on its quiet second line, and that is still the honest
shape. Single use makes the missing door **more** urgent, not less: the link is good for exactly one
arrival, so a customer who clicks it on a phone and then opens a laptop has only the password.

## Measured, on this Mac (Darwin 25.6.0, node v22.23.1), 2026-09-13

| what was run | result |
| --- | --- |
| `node --test tests/cp-relay-pair.test.mjs` | 10 pass, 0 fail |
| `node --test tests/cp-onboard.test.mjs` | 39 pass, 0 fail |
| `node --test tests/relay-tenant-login.test.mjs` | 23 pass, 0 fail |
| `node --test tests/cp-welcome.test.mjs` | 26 pass, 0 fail |
| `node --test tests/login-ledger.test.mjs` | 14 pass, 0 fail |
| `node --test tests/cp-admin-guard.test.mjs` | 2 pass, 0 fail |
| `node --test tests/cp-*.test.mjs tests/onboard-seam.test.mjs tests/login-ledger.test.mjs` | 570 pass, 0 fail |
| `node --test tests/relay-*.test.mjs` | 294 pass, 0 fail |
| `node scripts/verify-onboard.mjs` | 26 passed, 0 failed, 0 not measured |
| `node scripts/lib/proxy-legs/box.mjs` | PASS, 38 checks |
| `node --check` on every touched `.mjs` and `.js` | clean |

**The test that matters most is the joining one.** docs/ONBOARDING.md 14.1 says that when a wave ships
both ends of a new HTTP contract, the joining test uses the **real** route. Everything else here has a
hand-written double on one side: the relay suites answer a fake control plane, the store suites drive
the store directly. ONBOARD-2 lost a welcome to exactly that arrangement, twice. So
`tests/cp-relay-pair.test.mjs` gains three legs that drive the **real** `cp/onboard.mjs` mint writing the
**real** store, the **real** `POST /v1/relay/sign-in-links/claim` out of `cp/server.mjs`, and the **real**
`ui/server.mjs` `handleSso` reaching it over a real socket. They prove the field names cross, the row
moves, the second click is refused, a revoked link is refused, an unrecorded link is refused, and the
claim route is opened by the relay credential and not by the admin token.

The `box` leg of `verify-proxy` also clicks a real link twice against a real relay copy and measures
that the console asked once and that the second click answered 401.

## What is NOT proven

1. **Nothing ran on the R750.** No live control plane, no live relay, no real customer.
2. **No real welcome mail was sent carrying a recorded link.** The mail path is proved against the real
   sender and the real store in `tests/cp-welcome.test.mjs` and `tests/onboard-seam.test.mjs`, and the
   relay's product-mail door is stubbed in both.
3. **`scripts/verify-onboard-r750.mjs` leg 5b has never been executed.** It is written: the customer's
   own link refused on a second click with the sentence read off the page, a fresh link listed live on
   the panel, Revoke, then the cancelled link refused, plus two screenshots. It needs the R750 and an
   operator.
4. **No browser was driven against the new Sign-in links row.** The routes behind it are measured; the
   rendering is not. `cp/admin/admin.js` changes are `node --check` clean and nothing more.
   `scripts/verify-onboard-panel.mjs` could not be attempted at all: `playwright-core` does not resolve
   through this worktree's `.cache/playwright` symlink, and installing into the shared main checkout
   while other workers are running it is not a thing to do unasked. One rendering bug was caught by
   reading rather than by running, and it is worth knowing about because it is the kind a screenshot
   would have shown instantly: the first cut of the chip used the panel's `ago()` helper on an expiry,
   and that helper clamps at zero, so a link good for another twenty hours would have read *for 0s ago*.
5. **Timing under load was not measured.** Every click now costs one control-plane round trip inside a
   10 s timeout. On a local socket that is sub-millisecond; behind Cloudflare and Traefik on the R750 it
   is unmeasured.
6. **The prune was measured with an injected clock only.** Seven days of real wall clock were not waited
   out, and no table has yet grown large enough for the prune to matter.

## One cost taken deliberately, and not hidden

A click on a link whose signature verifies now costs the relay one control-plane round trip, and the
sign-in-link door is not behind the password lockout. So somebody holding one valid link can make the
relay ask the control plane once per request. That is bounded two ways and was accepted rather than
limited: the token has to verify under that workspace's derived key, which means the caller already holds
a working credential, and a token that does **not** verify is refused without asking anybody, which is the
case an unauthenticated stranger can actually produce. The behaviour it replaces was worse: every one of
those clicks used to mint a session. A limiter was considered and left out because the first thing it
would break is the legitimate person who double-clicks their own link and deserves a sentence rather than
a rate-limit page. If the round trips ever show up on the R750, the limiter goes in then, with a number
measured rather than guessed.

## Two pre-existing faults fixed on the way past

**The Sign-in attempts panel named the wrong credential for every link login.** CP-FIX added the `link`
door to the relay's ledger on 2026-09-12 and `cp/admin/admin.js` still read anything that was not
`account` as "instance password". Same class of wrong as the count that said beta-36's tester had never
logged in. It reads *sign-in link* now, and the refusal's reason is drawn under the outcome chip.

**`cp/admin.mjs` has been asking `listWelcomeSends` for five rows and getting twenty since ONBOARD-2.**
It calls `listWelcomeSends(slug, {limit})` and the store's signature is a bare number, so the object
became `NaN` and fell through to the default. Harmless and still wrong, and a caller passing a shape the
callee ignores is how a cap stops being a cap. The store takes both shapes now.

## Files

Owned and changed as scoped: `ui/server.mjs`, `ui/login-ledger.mjs`, `cp/onboard.mjs`, `cp/admin.mjs`,
`cp/store.mjs`, `cp/admin/admin.js`, `docs/TENANCY.md`, `docs/GAP-ANALYSIS.md` (ONBOARD-3 and ONBOARD-5),
`tests/relay-tenant-login.test.mjs`, `tests/relay-tenant-endpoints.test.mjs`,
`tests/relay-one-console.test.mjs`, `tests/relay-mail-tenant-claim.test.mjs`, `tests/cp-onboard.test.mjs`.

**Changed outside the scope I was handed, each for a stated reason:**

| file | why it had to change |
| --- | --- |
| `cp/welcome.mjs` | The welcome mail's link is minted HERE, not in `cp/onboard.mjs`. "The welcome mail's link is the same kind" is not satisfiable without it. |
| `cp/server.mjs` | The relay route has to live somewhere. `cp/admin.mjs` claims only `/v1/admin/*`, so a `/v1/relay/*` route cannot go in it. One route added beside the existing relay routes. |
| `tests/relay-tenant-support.mjs` | `signInAsTenant` is the shared link sign-in helper; three suites use it and all of them would refuse every link without a control plane to ask. Gains `startLinkCp` and `startRelayWithLinks`. |
| `tests/cp-relay-pair.test.mjs` | The joining test docs/ONBOARDING.md 14.1 requires. There is nowhere else in the tree that runs both real halves against each other. |
| `tests/cp-welcome.test.mjs` | Its own doubles had to learn the new refusal, and the welcome's recorded link needed a case. Stale "unrevocable" language corrected. |
| `tests/login-ledger.test.mjs` | It asserts the row's exact key set, so a new field is a deliberate update there. A case for the cap and for the doors that write no reason was added. |
| `tests/cp-admin-guard.test.mjs` | The two new admin routes belong on the negative-authorisation net, with the link proved un-cancelled after every forged credential. |
| `scripts/lib/link-claim-cp.mjs` (new) | One claim stub for the gates, rather than a third copy of it in each leg. |
| `scripts/lib/proxy-legs/box.mjs`, `box-live.mjs` | Both sign a customer in by link with `CP_URL` pointed at port 1, so both would have measured a 503 and nothing else. |
| `scripts/verify-onboard.mjs` | Its header called the link stateless and unrevocable, and one check was labelled "its link works once" while asserting only that something answered. Label now says what is measured. |
| `scripts/verify-onboard-r750.mjs` | Leg 5b, so ONBOARD-5 has a live proof path at all. Never executed. |
| `docs/ADMIN.md` | It described the link as multi-use and unrevocable in three places, which is now false. |
