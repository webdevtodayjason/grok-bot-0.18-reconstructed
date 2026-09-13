# CP-FIX: four control plane defects, each measured before it was fixed

Branch `night-cp-fixes`, overnight 2026-09-12 into 2026-09-13. The row in
`docs/OVERNIGHT-2026-09-12.md`: the boot error on every control plane start, the Clients panel's
sign-in count, a lockout after a password change that never reached a ledger, and DEVICE-1.

Three of the four came out of one live session. A beta tester's box (`beta-36`) spent 9.7M input
tokens in 38 minutes on 2026-09-12 while the panel said he had never logged in, and the three defects
that hid it are written up in the memory note `beta-36-token-burst`. Everything below was measured on
**this Mac**, with the relay and the proxy faked at their own wire shapes. Nothing here was measured
on the R750: a worker does not touch it. What that leaves unproven has its own section at the end.

| commit | what |
|---|---|
| `fb029eb` | a plan model that names itself has no screenshot fallback, and the boot is silent |
| `ffa8016` | a login by sign-in link is a login, and the panel names the kind of the last one |
| `3b7a6b9` | a failed sign-in says why, in words, and a password change is one of the reasons |
| `215bf2c` | DEVICE-1: removing an account takes its device bearers with it |

## 1. The boot error nobody could act on

**Measured first.** The fake proxy was taught the refusal the real build has (the stub in
`scripts/lib/proxy-legs/stub-proxy.mjs` has modelled it since the proxy legs were measured; the test
fixture answered 200 and stored it). With a deployment carrying `tb_vision_fallback` set to its own
alias, the boot reconcile reported:

```
vision fallbacks: plan-minimax still has no route to plan-minimax, the proxy answered 400:
Model 'plan-minimax' cannot be its own fallback
```

That is the line on every start. There was nothing behind it to act on.

**Why it resolved to itself.** Every customer-visible plan model has to either take images or name
one a screenshot falls back to, because every Titan turn can carry a screenshot. Naming yourself
satisfies that guard and registers no route, and `plan-minimax` shipped in exactly that state. The
Providers panel has refused new self-naming since PROVIDERS-1 unless that model's own vision check has
passed, which is how a model says "images stop here". What nothing did was stop the boot reconcile
reading the stored name back and trying to write it.

**The fix is one reader.** `visionFallbackTarget` in `cp/proxy.mjs` answers `""` for an empty field
and for a deployment that names itself, and the boot reconcile, the Providers answer and the panel
card all resolve a route through it. Such an alias never enters the wanted map, so it is neither
restored nor skipped and the boot prints nothing about it. A plan model with no other plan to fall
back to simply has none.

**Measured after:** `restored` empty, `skipped` empty, the real `plan-zai` pair still reconciled on
the same pass, and the proxy's map holding only that pair.

## 2. A login by sign-in link was not a login

**Measured first.** With the relay reporting one successful sign-in-link login a minute old, the
Clients panel row came back as

```json
{"id":"...","email":"tester@beta36.test","name":"","tenant":"beta-36",
 "superAdmin":false,"disabled":false,"createdAt":1789275557716,"lastSignInAt":null}
```

`lastSignInAt: null` is what the panel draws as **never**. There was no count field and no kind field
to draw either.

**Two holes, one per side.**

The relay wrote nothing at all for the link door. A sign-in link is minted by the control plane and
verified at the relay against the workspace's own key; no password is typed, `POST /v1/sessions` is
never called, and the control plane cannot hear about it any other way. `handleSso` logged one console
line. It now writes the attempt to the same ledger the two password doors write to, under a third door
named `link`, on all three of its answers. No password exists on any branch, so nothing is hashed.

And the panel read the control plane's ledger alone. The per-person count now merges both through
`mergeAttempts`, the same reader the Sign-in attempts panel uses, so an attempt a tenant console
forwards is one sign-in and not two. Each row carries `signIns`, `lastSignInAt` and `lastSignInKind`
in words: *by sign-in link*, *with an email and password*, *with the instance password*. A relay that
cannot be asked makes the count short, so the panel prints one line saying so rather than letting
every "never" under it read as a fact.

**Measured after:** `signIns: 1`, `lastSignInKind: "by sign-in link"`, `lastSignInAt` the time of the
link. A password login recorded by both sides counts once. Two link attempts at a real relay copy
produced two ledger rows, one `ok` carrying the tenant and the person off the verified token and one
`refused`, neither with a hash.

**This is the one place the batch went outside its file list.** `ui/server.mjs` (the sign-in-link
handler) and `ui/login-ledger.mjs` (the door set) are relay files. Both edits are local and the
reason is unavoidable: the control plane cannot count a row nobody writes.

## 3. A failed sign-in now says why

**Measured first.** Driving the real `POST /v1/sessions`: change an account's password through the
operator route, then sign in with the one the customer still holds, and the ledger row reads
`outcome: "refused"` with `reason: ""`. Same empty field on a lockout, on a disabled account, and on
an account whose workspace has been removed. The last two wrote **no row at all**.

**Five answers now write their own sentence.** Measured after, verbatim from the ledger:

```
refused: the password did not match the one on file, which was changed less than a minute ago
locked: too many failed tries on this account and this address in the last ten minutes, so the
        door is shut for 600 more seconds
```

and in the same shape for a door that was turned off, for a workspace that is no longer registered,
and for the concurrency cap, which refused sign-ins silently before this.

**Two facts had to exist for the first sentence.** `accounts` gained `password_changed_at`, because
`updated_at` moves for a promote and a disable too and cannot answer when the password changed.
`loginLock` now names which bucket fired, this account or this address, so a lockout can say what is
happening rather than only how long it lasts.

**Nothing on the wire changed.** A wrong email and a wrong password still answer with the identical
401 body, because telling them apart tells a guesser who has an account here. The reason is what the
operator reads. No reason is derived from a password, the keyed hash is still the only thing that is,
and the store caps a reason at 200 characters with its newlines taken out. `password_changed_at` is
deliberately not in `publicAccount`, so the key set `/v1/accounts` answers is unchanged.

The Clients panel draws the newest failure under the time, with its sentence and a count of how many
there have been. Failures come from the control plane's ledger only, on purpose: a relay row carries
an outcome word and no reason, because the relay does not decide any of these.

## 4. DEVICE-1: the phones outlived the account

**Measured first.** With a relay standing in front of the device routes, `DELETE /v1/accounts/<email>`
answered 200 with no `devices` field at all and never asked the relay anything. That matches the R750
on 2026-09-10, where two bearers belonging to a removed account were still opening `/api` and `/push`
on the demo workspace with the rest of their thirty days to run.

**The fix.** The route asks the relay for that workspace's device rows, revokes every live one whose
`sub` is this account, then deletes the account row. By `sub` and never by workspace: two people can
share a workspace, and revoking the workspace's devices to close one account would sign a colleague's
phone out. A test pins that the colleague's Mac is untouched and is never even named in a delete.

**A relay that cannot be asked does not stop the removal.** The account goes, `devices.asked` is
false with the reason, and the message names the command that finishes the job.

**The refusal a dead bearer meets** is the front door's own `401 {"error": "not signed in"}` with
`x-relay-auth: required`, now asserted on the very route this change calls rather than on a new
sentence invented for it.

**Measured after:** two bearers revoked, one list and two deletes at the relay, the third row still
live, and the operator's sentence reading *"2 device bearers on acme were revoked, so an app signed in
on them stops at its next request."*

A tenant teardown needs nothing here: `cp/decommission.mjs` deletes a slug's accounts at its last
step, by which point the container is gone and the workspace is out of the relay's registry, so a
bearer for it has nothing left to open.

## What was run

On this Mac, `node --test`:

| suites | result |
|---|---|
| every `tests/cp-*.test.mjs` (25 files) | 516 pass, 0 fail |
| `login-ledger`, `relay-tenant-login`, `relay-device-bearer`, `relay-admin-routes`, `auth-device` | 82 pass, 0 fail |

`node --check` on every touched file: `cp/server.mjs`, `cp/admin.mjs`, `cp/store.mjs`, `cp/proxy.mjs`,
`cp/admin/admin.js`, `ui/server.mjs`, `ui/login-ledger.mjs` and the six test files.

Fourteen new cases. One existing assertion changed: the exact-key-set pin on the store's own account
row in `tests/cp-store.test.mjs` gained `passwordChangedAt` by name, with the reason written into the
test. That pin exists to prove nothing derived from a password joins the row, and a timestamp is not
one; the new case beside it asserts a fresh account reads 0.

## What is NOT proven

1. **Nothing was measured on the R750.** A worker does not touch it. Every number above comes from
   this Mac with the relay and the proxy faked at their own wire shapes.
2. **The boot line is gone in a test, not on the live console.** The proof is that the reconcile
   neither writes nor reports a self-naming alias. Confirming the silence needs one control plane
   restart on the R750 and a look at its first lines. `plan-minimax` is still carrying
   `tb_vision_fallback: plan-minimax` in the live proxy's database; nothing here changes a stored
   value, deliberately, because that is an operator's row to edit. The line will stop either way.
3. **No live sign-in-link login was counted.** The relay half is proved against a real relay copy on
   a real port, and the panel half against a faked relay answer in that exact shape. The two have not
   met on one machine. `beta-36`'s own row will not back-fill: the ledger rows for his 13:52 link
   login were never written, so he reads as never until he signs in again.
4. **The existing 30 day pruning applies to reasons as well.** A refusal older than that is gone with
   its sentence, which is the same rule the table already lived by.
5. **DEVICE-1's revoke was never run against a real `devices.json`.** The relay's own routes are the
   shipping code and `relay-device-bearer` drives them on a real port, but the control plane's new
   call has only met a fake. A live check is `cp account remove` on a throwaway account holding a
   bearer, then `cp device list <slug>`.
6. **The Clients panel was not opened in a browser.** `cp/admin/admin.js` changes are covered by the
   answer shape they render and by the source greps in `cp-admin`, not by a rendered page. Per the
   memory note on verifying UI, a passing test is not evidence a human can read the cell.
7. **The concurrency-cap refusal now writes a row per refused request.** That branch only fires when
   four scrypt derivations are already running. It is the same order of writes the wrong-password path
   already does, and the table is pruned at 30 days, but it has not been measured under a flood.

## Left for the operator

- One control plane restart on the R750 to confirm the boot is silent, and a look at whether
  `plan-minimax` should keep `tb_vision_fallback` pointing at itself or be given a real target in the
  Providers panel.
- `cp account remove` on a throwaway account that holds a device bearer, to see the revoke land on a
  real `devices.json`.
