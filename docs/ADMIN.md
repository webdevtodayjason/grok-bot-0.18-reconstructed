# The super admin console

ADMIN-1. One person's view of the whole product, at `https://api.titanium.bot/admin`.

Jason, 2026-09-07: "An admin console is merely for a super admin of the entire system... Client
accounts, payment details that we don't have yet, the health of their boxes, the health of this
overall system." And at 15:12: "we should capture tries, users and passwords tried and report in the
Super admin for failures with IP."

Everything on it is read-only except six named actions: stop, start, restart or rebuild a customer's
workspace, and turn one person's sign-in off, back on, or reset their password.

---

## The two commands that give you your own account

You do not have an account yet. These two make one, and the second is what opens this console. Run
them on the R750, where `CP_ADMIN_TOKEN` is already in `/home/sem/titanbot/cp.env`:

```sh
node cp/cli.mjs account add jason@titaniumcomputing.com titanium
node cp/cli.mjs account promote jason@titaniumcomputing.com
```

The first asks for a password on the terminal with the echo off, twice. It never takes one as an
argument, because an argument ends up in the shell history and in `ps`. `titanium` is your own
workspace, the one `console.titanium.bot` already serves, so the same email and password sign you in
to both: the console for your own agents, and `/admin` for everybody's.

`account demote <email>` takes the flag back. The last super admin cannot be demoted, because that
would leave a console nobody can open; promote somebody else first. `account list` now has a role
column, so you can see who holds the flag and whose sign-in is off.

Making somebody a super admin is deliberately its own command rather than a flag on `account add`.
It is the one thing on this service that hands over the whole system, and it should have its own
line in the shell history.

---

## The password decision, in plain words

When somebody's sign-in is refused, we write down a keyed hash of the password they tried. We never
write down the password.

The reason is that the panel has to tell two stories apart. One address trying the **same** wrong
password forty times is somebody's phone with a saved password that stopped working, or a script
with one leaked credential. One address trying forty **different** passwords is an attack. Those
look identical unless something about the password itself is kept, and if you cannot tell them
apart you either chase the phone or ignore the attack.

So what is kept is HMAC-SHA256 of the password under a key that is 32 random bytes, generated once,
written 0600, and never sent anywhere. Two things follow. Reading the ledger tells you that two
tries were the same password and nothing else, because a keyed hash with no key is not worth running
a dictionary against. And the relay and the control plane keep **separate** keys, so a hash written
by one is never comparable to a hash written by the other, and stealing either file does not widen
the other's blast radius. The panel counts distinct passwords per source for exactly that reason.

A sign-in that **worked** gets no hash at all. There is no reason to hold anything derived from a
password that was correct, and a file of keyed hashes where one entry is known-good is a worse file
than one where none is.

---

## Where the two ledgers live

There are two, and it is not redundancy.

The **relay** writes `login-attempts.jsonl` into its own state directory, which is `/state` in the
container and `/home/sem/titanbot/state` on the host. It rotates at 5 MB and keeps one previous
file, so the ceiling on disk is 10 MB. A row is
`{at, door, email, ip, userAgent, triedHash, outcome, tenant}`. It has to be the relay's own
directory and not a customer's, because a refused sign-in has no customer yet: somebody typing a
wrong email at the login page belongs to nobody, and a per-tenant ledger would simply lose them.

The **control plane** keeps a `login_attempts` table in its own sqlite. That is not the same table
as `login_failures`, and the difference matters: `login_failures` is the lockout's counter, cleared
on a successful sign-in and pruned to a ten minute window, so by design it cannot answer "who has
been knocking today". `login_attempts` is the record, kept for thirty days, and nothing clears it
early.

The panel shows them as one list. A sign-in that came through the console is written down on both
sides, because the relay forwards it, so a control plane row that matches a relay row on address,
email and outcome within two seconds is dropped in favour of the relay's, which knows which door was
used and what the browser called itself. What survives from the control plane's own side is the
thing that table exists for: an attempt that never went through the console at all, which is a
client posting straight at `api.titanium.bot`.

The control plane reads the relay's file over `GET /admin/login-attempts`, behind `CP_RELAY_TOKEN`,
the same credential the relay already uses on the registry route. One shared secret between those two
services, not two.

### The attack rule

**Six or more different passwords from one address inside ten minutes** raises the Attack chip.

Six because the relay locks an address out after five failures, so an address that reached six
distinct passwords either waited out a lockout on purpose or came in through a door with a different
counter. Neither of those is a person who forgot their password. Ten minutes because that is already
the control plane's own lockout window, and one window in the product beats two.

It is a sliding window, not a calendar bucket, so somebody who straddles the top of the hour is still
caught. Six passwords spread twelve minutes apart are not flagged, and they should not be: that is a
person, slowly.

---

## The five panels, and where every number comes from

Every number carries the moment it was measured. Anything that could not be measured says **"not
measured"** and why, and never a zero, a dash, or a green tick.

### 1. Sign-in attempts

Both ledgers, merged. The table by address gives you tries, refused, locked out, signed in, the
accounts that were named, and the sentence that matters: "the same password 4 times" or "6 different
passwords". The Attack chip appears on an address that meets the rule above. Filters for the window
and the outcome are at the top; the "Seen by" column says whether a row came from the console or from
this service.

### 2. Clients and users

One card per customer: the workspace, its status in our own ledger, what Coolify says about it right
now, and `plan: none`, which is said out loud rather than left blank because "we do not bill yet" is
a fact about the product. Under it, the people who can sign in: when they were added, when they last
actually got in (from the sign-in record, and "never" is a real answer), and whether they hold the
super admin flag or have their sign-in turned off.

The four workspace buttons go through the same code path as `cp/cli.mjs tenant`, including the guard
that refuses to rebuild an adopted instance. That guard matters here more than anywhere: `titanium`
is your own live console, and rebuilding it would stand a second copy up beside it.

Turning a sign-in off is reversible and touches nothing else: the password, the workspace and the
files all stay. A session they already hold keeps working until it expires, which is at most twelve
hours. Reset password hands back one temporary password, shown once, stored as a scrypt hash like
every other password here. Nothing can be asked for it again. You cannot turn off your own sign-in
from this console.

### 3. Box health

| What | Where it comes from |
|---|---|
| Coolify status | the Coolify api, live, per service |
| Container state | `docker inspect` **on the relay** |
| Gateway answering | the relay calls the box's own gateway with that customer's bearer |
| Last activity | the newest write under `/data/titanbot/<slug>/volumes/data`, read by the relay |
| Disk | `du -sk` on `/data/titanbot/<slug>`, run by the relay |
| Memory | `docker stats --no-stream` on the relay |
| Last backup | the newest nightly manifest. **Not measured**, see below |

Container state and gateway answering are asked separately on purpose. They come apart often enough
to matter: a box whose host process died still has a container in state `running`.

Last activity is a lower bound and should be read as one. It is the newest file write in the
customer's data volume, which is where the agent stores live, so it tells you which customers are
actually using the thing. It cannot tell an idle box from a stuck one.

### 4. System health

| What | Where it comes from |
|---|---|
| Host load | `/proc/loadavg`, which is not namespaced, so it is the machine |
| Host memory | `/proc/meminfo`, same |
| Free on `/data/titanbot` | `statfs` on the bind mount |
| Coolify reachable | a live `GET /projects` against the api |
| Relay reachable | a live call to the relay's admin route |
| Control plane version | the service's own `CP_VERSION` |
| Builds that never finished | the provisioning ledger: `provisioning` for more than 15 minutes |
| Sign-ins in the last day | the control plane's own record |
| Mail webhook | **not measured** |
| Nightly backup | **not measured** |
| Box isolation check | **not measured** |
| Free on the archives mount | **not measured** |

### 5. Payments

"Not connected yet. Plan and billing appear here when Stripe is wired in."

---

## What is not measured, and what would fix each one

The control plane's container has exactly one bind mount, `/data/titanbot`, and deliberately no
docker socket. That is written into `deploy/coolify/control-plane.compose.yml` on purpose: this
service holds the Coolify api key and the session secret every relay trusts, and a docker socket in
it would be root on the host. So the docker facts are asked of the relay, which already has the
socket, and three facts are on neither container.

**The nightly backup.** The manifests are under `/mnt/rosa-storage/archives/titanbot/backups/`,
which is mounted into no container at all. Set `CP_BACKUP_MANIFEST_DIR` to a directory this service
can read and the panel fills in: the stamp, whether the copy was `consistent` (everything paused) or
`live` (taken while things were running), how many workspaces and agent databases it held, and which
customers were in it. Until then it says so.

**The box isolation check.** `deploy/r750/box-isolation.sh --verify` prints its verdict and writes no
file, so there is nothing here to read. Set `CP_ISOLATION_REPORT` once a timer writes one; the shape
expected is `{at, ok, detail}`.

**The mail webhook.** It is configured on the relay and its secret lives there. This service has
neither, so it cannot honestly report on it. Check it in the console's own Email card.

**Free space on the archives mount.** Same reason as the backup manifests: not mounted here.

Each of those renders as the words "not measured" with the reason on hover. That is deliberate. A
made-up green light is how an outage gets missed.

---

## The door

Two credentials open the admin routes and nothing else does.

`CP_ADMIN_TOKEN`, which is how the CLI promotes the first super admin on a system that has none, and
which is the way back in if the console is ever locked.

Or a session whose account carries the super admin flag. The flag is read **from the store on every
single request**, never from the token. A session token is a fact from whenever it was minted, and
"this person was demoted" has to mean demoted now rather than in up to twelve hours. The gate
measures exactly that: it demotes an account with a live session and the very next request is 401.

A normal customer's own valid session opens none of it. Neither does the relay's credential: the
admin token and the relay token never open each other's routes.

The page itself at `/admin` is public, and it has to be, because it carries the sign-in form. There
is no customer data in those three files: no count, no name, no hostname. Every byte the panel
renders arrives from a route that refuses anything but a super admin. The page loads nothing from
anywhere: no framework, no CDN, no font service. It says so in its own content security policy.

The session lives in `sessionStorage`, so it dies with the tab. It is never in a URL and never in a
cookie.

---

## Running the gate

```sh
node scripts/verify-admin.mjs
node scripts/verify-admin.mjs --no-browser     # the API legs only
```

It starts a control plane of its own on a free port with a throwaway data directory, a fake Coolify
and a fake relay serving a built-in login-attempts fixture. It needs no box, no docker and no
network. The fixture has three stories in it because those are the three the panel exists to tell
apart: six different passwords from one address, the same password four times from another, and one
ordinary bad morning.

The page leg drives a real headless Chrome. It needs playwright, which
`scripts/setup-gates.sh` installs under `.cache/playwright`; point `GROK_BOT_PLAYWRIGHT_DIR`
somewhere else if yours is elsewhere, or pass `--no-browser`.

Exit 0 every leg passed, 1 a leg failed, 2 nothing was measured.

The unit tests are `tests/login-ledger.test.mjs` and `tests/cp-admin.test.mjs`, in
`node --test tests/`.

---

## What is next

**AUTH-MFA-1**, the wave after this one, puts passkeys and authenticator codes on the same door.
Super admins will be required to enrol, which is the right order: this console is the account worth
protecting most, and today it is one password.

**PROXY-1** brings per-customer usage into this panel once the metering proxy exists.

Stripe fills in the Payments panel.
