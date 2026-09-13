# CP-2: the adopted workspace, and the data a removal keeps

Two control plane items from the overnight batch of 2026-09-12, built on branch `night-cp2` on this Mac
(Darwin 25.6.0, node v22.23.1). **Nothing here has touched the R750.** A worker cannot reach it, so every
number below was measured on this machine, and section 4 lists what that leaves unproven.

## 1. SUPPORT-1d: an adopted workspace the rest of the service can talk to

**What was wrong, measured on the R750 on 2026-09-13** and written up in `docs/SUPPORT.md` section 8. The
one adopted workspace, `titanium`, had been claimed with `tenant adopt` without `--box`. Its row carried
`box_container` NULL beside a Coolify service uuid, and no gateway token for it existed anywhere this
service reads. The first three mails ever to arrive at `support@titanium.bot` were stored and told nobody:
the support desk answered "this workspace has no container name on its row", then "this workspace's
gateway token could not be read". An operator repaired it by writing a database column and a 0600 file on
a live server by hand.

### (a) One container name, one helper

`cp/provision.mjs` gains `boxContainerFor(row)`. A written `box_container` still **wins**, for the reason
its own comment has always given: a re-provision mints a new uuid, and a reader that rebuilt the name off
a stale row would land on a container that is not this customer's. When nothing is written and there is a
service uuid, the name derives as `titanbot-box-<uuid>`, which is what Coolify really calls it.

Six readers asked that question in six places, and three of them read the column alone. Every one now
calls the helper:

| reader | what it does with the name | was it broken |
|---|---|---|
| `cp/server.mjs` relay registry | serves the row to the relay | no, it derived inline |
| `cp/server.mjs` `refreshBoxPeers` | holds a box's address **untrusted** as a forwarder | **yes** |
| `cp/support.mjs` | the notification into the operator's workspace | **yes** |
| `cp/onboard.mjs` health step | the `/health` probe on a new box | no, it derived inline |
| `cp/onboard.mjs` `boxCall` | the plan model, the ceiling, Titan's introduction | **yes** |
| `cp/admin.mjs` Box health | the panel's Container column | **yes** |
| `cp/decommission.mjs` | carried to the relay's purge route | no, it derived inline |
| `cp/cli.mjs` `tenant list`, `proxy mint` | the column, and the box a key is pushed into | **yes** |

`refreshBoxPeers` is the one with teeth and it was not in the brief. That set is what keeps a box's own
address out of the trusted-forwarder set (`docs/TENANCY.md` section 19.3); an empty name contributed
nothing to it, so the adopted box was never held out. A trusted address can forge `X-Forwarded-For`, which
the sign-in lockout is keyed on. It is fixed in the same pass and flagged here because it is a security
consequence of the same NULL column rather than the cosmetic one the brief describes.

The adopt route and `tenant adopt` both write the column through the same helper, so `--box` or the rule.

### (b) The token has a way in, and the verb will not finish without one

`--gateway-token-stdin` reads the token from stdin, or from the terminal with the echo off when stdin is a
tty, and writes `profileDir/local-docker-vm.json` at 0600. **Never from an argument**, for the three
reasons `account add` has never taken a password as one: the shell history, `ps` output, and the
scrollback of whoever is watching. This token opens a customer's whole box.

The verb refuses to finish an adopt with neither that flag nor an existing file. It **checks before it
calls the route**, so a refusal claims nothing, and it names the file it looked for and both ways to
supply one. A row with no token is a workspace the relay answers 401 for with nothing in any log to say
why, which is the state that existed for weeks.

One more read had to move for the flag to be worth anything: `readGatewayTokenFor(store, slug, config)`
resolves an adopted workspace's profile directory the way `proxy mint` already did. Before this, the relay
registry had that read inline and was the only thing in the service that got it right, so a token written
where the adoption recorded it was invisible to the support desk and to the onboarding sequence. Without
this half, the new flag would have written a file nothing read.

`adoptedProfileDirDefault(config)` and `adoptedStateDirDefault(config)` moved into `cp/provision.mjs` so
the CLI can know where the route will put the file before it calls it, with one join rather than two.

## 2. ONBOARD-4: thirty days, counted

A removal with the data switch off kept the customer's files and **nothing looked at them again**. The
card said so honestly, because there was no reaper in this product, and it was still a leak: kept data is
real disk on the R750 (`/data`, 2.6 T with 1.9 T free on 2026-09-10) growing one removed customer at a
time with nothing watching it.

**The marker.** The removal writes `kept-until.json` into the customer's own directory, 0600, carrying the
slug, `removedAt`, `keptUntil` thirty days out, the window it used, the reason, and **the container name**.
That last field is there because of what ONBOARD-6 measured: the relay's registry has forgotten a removed
workspace, so `POST /tenant/purge` answers `409 container_unknown` unless the caller carries the name, and
once the Coolify service is gone there is nowhere left to look it up.

It is written in **both** cases where files end up kept: the switch off, and a purge the relay refused.
The second is the worse one, because the operator asked for the data to go and it stayed, so leaving that
tree uncounted was the one case nobody was watching on purpose.

**The sweep** is `cp/kept.mjs`, started once at boot and then hourly from `cp/server.mjs`, unref'd and
swallowing its own failures on the box-peer timer's pattern. Each pass reads the directories under
`CP_TENANT_ROOT`, keeps only the marked ones, asks the relay for each size with `probeOnly`, lists them on
**Box health** with the date, the days left and the size in words, and deletes one whose date has passed
through the same purge route the removal uses, logging one line each:

    kept data: acme-roofing deleted, 5.9 MB freed (kept from 2026-09-13 until 2026-10-13)

Three rules hold it honest. **Nothing without a marker is ever touched**, so ONBOARD-6's orphan stays an
operator's problem rather than a timer's. **A marker it cannot read never becomes due**, because the
alternative is a parse error deleting a customer's files. And the deleting and the measuring both go
through the relay, because this service runs as uid 1001 and a box's volumes are 0700 uid 1000: a size it
could not get reads "not measured" with the reason, never a zero.

### The one departure from the row's own next action

The ONBOARD-4 row asked for "deletes only what an operator confirms" and "nothing is deleted without a
press". **What shipped deletes automatically once the date has passed**, on the orchestrator's explicit
instruction in the task for this wave. The press is gone and the date is the gate. The argument for it is
that the operator already made the choice at removal, when they left the switch off, and the card now
tells them the day; the argument against it is that a date is a weaker consent than a press, and an
operator who never opens Box health will not see the list before the first deletion. Flagged here rather
than quietly reconciled.

### Sentences that had to change, because the fact changed

`Their data is kept at <path>. Nothing deletes it on a timer.` was asserted word for word in
`tests/cp-remove.test.mjs` and in `scripts/verify-onboard.mjs`, and stated in `cp/cli.mjs`'s confirm
prompt, `cp/admin/admin.js`'s remove card, `docs/ONBOARDING.md`, `docs/TENANCY.md` and `docs/ADMIN.md`.
All of them now name the day. The two assertions were not weakened to pass: each one now holds the
stronger thing, which is the marker on the disk and the date inside it.

## 3. What was measured, on this Mac

Every suite run with `node --test`, sequentially, on Darwin 25.6.0 with node v22.23.1.

| suite | result |
|---|---|
| `tests/cp-kept.test.mjs` (new) | 10 pass, 0 fail |
| `tests/cp-adopt.test.mjs` (new) | 8 pass, 0 fail |
| `tests/cp-remove.test.mjs` | 35 pass, 0 fail |
| `tests/cp-support.test.mjs` | 25 pass, 0 fail |
| `tests/cp-provision.test.mjs` | 37 pass, 0 fail |
| `tests/cp-admin.test.mjs` | 44 pass, 0 fail |
| `tests/cp-onboard.test.mjs` | 39 pass, 0 fail |
| `tests/cp-server.test.mjs` | 42 pass, 0 fail |
| `tests/cp-relay-registry.test.mjs` | 22 pass, 0 fail |
| `tests/cp-relay-pair.test.mjs` | 10 pass, 0 fail |
| `tests/cp-proxy.test.mjs` | 29 pass, 0 fail |
| `tests/cp-providers.test.mjs` | 41 pass, 0 fail |
| `tests/cp-store.test.mjs` | 24 pass, 0 fail |
| `tests/cp-voice.test.mjs` | 27 pass, 0 fail |
| `tests/cp-welcome.test.mjs` | 26 pass, 0 fail |
| `tests/cp-code.test.mjs` | 20 pass, 0 fail |
| `tests/cp-code-key.test.mjs` | 23 pass, 0 fail |
| `tests/cp-feedback.test.mjs` | 22 pass, 0 fail |
| `tests/cp-mail.test.mjs` | 12 pass, 0 fail |
| `tests/cp-mail-send.test.mjs` | 13 pass, 0 fail |
| `tests/cp-marketplace-admin.test.mjs` | 8 pass, 0 fail |
| `tests/cp-allowance.test.mjs` | 5 pass, 0 fail |
| `tests/cp-secrets-door.test.mjs` | 12 pass, 0 fail |
| `tests/cp-signins-gate.test.mjs` | 9 pass, 0 fail |
| `tests/cp-signup.test.mjs` | 13 pass, 0 fail |
| `tests/cp-session.test.mjs` | 15 pass, 0 fail |
| `tests/cp-admin-guard.test.mjs` | 2 pass, 0 fail |
| `tests/cp-admin-page-routes.test.mjs` | 3 pass, 0 fail |
| `tests/onboard-seam.test.mjs` | 4 pass, 0 fail |
| `tests/relay-purge.test.mjs` | 19 pass, 0 fail |
| `tests/relay-trusted-proxies.test.mjs` | 17 pass, 0 fail |
| `tests/box-health-sweep.test.mjs` | 10 pass, 0 fail |
| `scripts/verify-onboard.mjs` | **26 PASS, 0 failed, 0 not measured** |

`node --check` is clean on every `cp/*.mjs`, on `cp/admin/admin.js`, on every `tests/cp-*.test.mjs` and on
`scripts/verify-onboard.mjs`.

**One test was proved to be a test of the bug and not of the fix.** The new SUPPORT-1d case in
`tests/cp-support.test.mjs` was run against the old reads first, with the container taken off the column
alone and the token read under the tenant root, and it **fails** there. The helper was then restored and
it passes.

## 4. What is NOT proven

- **Nothing ran on the R750.** A worker has no route to it. So: no real `/data/titanbot` has been swept,
  no real tree has been deleted by the hourly timer, the Box health list of kept directories has not been
  seen in a browser, and the container derivation has not served a live adopted row.
- **The live adopted row is already repaired by hand**, which means proving the derivation on the R750
  needs either a second adopted workspace or `titanium`'s `box_container` cleared on purpose. That is an
  operator decision, not a worker's.
- **No browser leg** over the new Box health section. Its markup is asserted by reading
  `cp/admin/admin.js` in `tests/cp-admin.test.mjs`, which proves the code draws what it says and proves
  nothing about how it looks or whether a person can read it.
- **`--gateway-token-stdin` has never carried a real gateway token.** The CLI is driven as a real process
  in `tests/cp-adopt.test.mjs` against a real control plane, so the stdin path, the 0600 mode, the refusals
  and the registry read are all measured; the token in them is a test string.
- **The first real deletion is thirty days after the first real removal.** Nothing about this mechanism can
  be proved on the R750 sooner than that except the listing and the marker, which a removal proves
  immediately.

## 5. Files outside the assigned list that were touched, and why

The task named `cp/*.mjs`, `cp/admin/admin.js`, `tests/cp-*.test.mjs`, `docs/TENANCY.md`, `docs/ADMIN.md`
and the two gap rows. Three files outside that list were changed, each because it asserted or stated the
sentence the product no longer says, and leaving any of them would have left the tree broken:

- **`scripts/verify-onboard.mjs`** asserted `/Nothing deletes it on a timer\./` and refused any mention of
  thirty days. That gate would have failed on the first run. Its data-switch step now reads the marker.
- **`docs/ONBOARDING.md`** stated the old sentence in section 4 and carried a paragraph titled "There is no
  thirty day retention, and the card does not claim one". Both rewritten.
- **`cp/kept.mjs`** is new, which is inside `cp/*.mjs` but is worth naming because the sweep lives there
  rather than in `cp/decommission.mjs`: `cp/admin.mjs` needs the listing and `cp/server.mjs` needs the
  timer, and neither should import the removal to get them.

**`docs/SUPPORT.md` section 8 was deliberately NOT edited.** It still says an adopted tenant's row needs
its column and its token file written by hand today and that the product fix is filed as SUPPORT-1d, owner
the next wave. That wave is this one and those two sentences are now wrong. The file belongs to another
worker in tonight's batch, so editing it blind would collide. Owner: the orchestrator, or whoever holds
`docs/SUPPORT.md` next. Next action: replace the SUPPORT-1d bullet in section 8 with a pointer to
`docs/TENANCY.md` section 10, which carries the whole mechanism.

## 6. One thing found on the way past, not a live defect

`ui/purge-edge.mjs` `BOX_CONTAINER_RE` accepts `titanbot-box-` followed by lowercase letters and digits
only, so a container name with a dash after the prefix is thrown away and the route answers
`409 container_unknown`. Every Coolify resource uuid measured on the R750 is lowercase alphanumeric, so a
derived name can never hit this, and a name an operator passes with `--box` could. It cost an hour in
`tests/cp-kept.test.mjs`, where an invented fixture name had a dash in it and the purge refused. The
fixture now looks like a real one and says why in a comment. No code change; named here so the next person
does not spend the same hour.
