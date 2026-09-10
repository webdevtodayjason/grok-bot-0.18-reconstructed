# The super admin console

ADMIN-1. One person's view of the whole product, at `https://api.titanium.bot/admin`.

Jason, 2026-09-07: "An admin console is merely for a super admin of the entire system... Client
accounts, payment details that we don't have yet, the health of their boxes, the health of this
overall system." And at 15:12: "we should capture tries, users and passwords tried and report in the
Super admin for failures with IP."

## What this console is for

Jason, 2026-09-09 11:43: "If I was going to onboard a new client, would that be something I would do
from this console or is this console merely reporting? Where do I control things like the GitHub
token, managing providers, and the model we want to use from that provider?"

**You run the business from here.** It is not a reporting screen. This is where you:

- **add a client** and watch their workspace build, and then stop, start, restart or rebuild it
- **turn a person's sign-in off**, back on, or reset their password
- **hold the provider keys**: add one, roll one, remove one, add a provider, remove a provider
- **pick which model a workspace runs on**, and how many bots it may hold
- **paste the GitHub token** the Feedback panel files issues with
- **approve, suppress or close what an agent reported**
- **read** sign-ins, spend, box health and system health

The CLI is the second door, not the first one. `cp/cli.mjs` does every one of those things and writes
the same change record, so a script can do what you can do; it is there for when the console is not,
and for the two commands below that make the first account on a system that has none.

Everything not in that list is read-only. Payments are the one thing that is on neither door yet.

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
sides, because the relay forwards it, so a control plane row that matches a relay row within two
seconds is dropped in favour of the relay's, which knows which door was used and what the browser
called itself. What survives from the control plane's own side is the thing that table exists for:
an attempt that never went through the console at all, which is a client posting straight at
`api.titanium.bot`.

Which fields have to match depends on how the row arrived. A forwarded sign-in reaches this service
from the relay's own machine, so the address on the control plane's copy is that machine's egress
address and not the visitor's, and matching on address would keep every duplicate. Those rows are
marked `via: relay` when they are written and matched on the email and the outcome alone. They are
also left out of the by-address table, because that address belongs to nobody: it is one bucket that
would otherwise hold the whole fleet's console sign-ins and could raise the Attack chip on a phantom.
The relay's own row, with the real address, is the one in that table. On screen those rows read
"through the console" in the Address column.

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

### The spray rule

**One password tried against six or more accounts inside ten minutes** raises the Spray chip, however
many addresses it came from.

The attack rule above catches somebody working a password list against one account. It catches
nothing running the other way. One common password tried once against a hundred accounts from a
hundred addresses is a hundred rows, and every brake in the product misses it: the relay locks an
address out after five failures and no address here has one, and this service locks an email out
after ten failures and no email here has one. Nothing about any single row looks wrong. The attack is
only visible when the rows are lined up by who was being guessed at, which is what the By account
table is for, and by which password was tried, which is what raises the chip.

Same window and same number as the attack rule, for the same reasons, and the passwords are still
counted per source because the two services keep different salts.

### Telling a gate from an attacker

Jason, 2026-09-09 11:43, holding two screenshots of this panel: his own address marked **Attack**,
101 tries, 58 locked out, 23 different passwords, one of the accounts named his own. Nothing hostile
had happened. Every burst was this repository's own deploy gate doing exactly what it is written to
do: it types two wrong instance passwords, then seven more until the throttle answers, because the
rule it measures **is** the lockout. One burst per ship, from this Mac, since 2026-09-07.

The panel could not tell that from a stranger, and it could not because the rows carried nothing
about the caller but a user agent reading `node`, which is what node's own `fetch` sends when
nobody sets one.

**So the gates say their own name at the door.** Every gate that knocks at a login door sends
`User-Agent: titanbot-gate/<script name>`, so `titanbot-gate/verify-deploy`,
`titanbot-gate/verify-one-console`, and so on. The name is built from the script's own filename in
`scripts/gate-agent.mjs` rather than typed into each one, so a gate written next year gets it by
importing rather than by remembering.

**The header is a label and never a decision, and that is the important half.** A user agent is a
string a stranger writes. Anybody can send `titanbot-gate/verify-deploy`. The first shape of this
rule tried to make the header worth something by pairing it with a second test the outsider could
not forge -- the address had also signed in successfully as an operator inside the hour -- and then
letting the pair take those rows **out** of the Attack maths. Measured on this Mac on 2026-09-09,
that pair was broken: eight refusals with eight distinct passwords from one address read
`attack: true` with a plain agent and `attack: false` with the header on the identical rows, because
one operator sign-in from that address earlier in the hour was enough. Anyone sharing an office NAT,
a VPN egress or a compromised laptop with an operator who signed in that hour could turn the pill off
by writing a string.

**So nothing is subtracted.** A labelled row is drawn in grey, named, and **counted like every other
row**: it is in its address's attempts, in the distinct-password window, in the Attack rule and in
the spray table. What the label buys is ink and a sentence beside the number -- "116 tries, 11 of
them look like our own gates" -- so you can read a burst you recognise without the panel deciding for
you that it was harmless.

A row is marked, in one of two ways:

1. **it said so at the door** -- the user agent starts with `titanbot-gate/` and the attempt was
   refused or locked out. That is what every gate in `scripts/` sends. A gate that **gets in** made a
   successful sign-in and stays in the ok count, whatever its agent says.
2. **the dated clause** -- an attempt written before any gate carried a header, matched on its shape
   alone. That one has no name to go on, so it does ask that the address was signing in as the
   operator at the time, and the panel prints a different sentence for it: "an older row, from before
   gates named themselves".

The operator-address test still puts **"your address"** beside an address on the panel, which is a
fact about where you were signing in from and nothing more.

**A blank user agent is never enough on its own, ever.** Measured on this Mac: node's `fetch` with
no headers set sends `user-agent: node`, and node's raw `http.request` sends no user agent header at
all. Both shapes are in the live ledger, and the second comes from the deploy gate's one leg that uses
raw https, which runs three times a run. But a blank agent is **also** what every row written by the
control plane's own door carries, because that service does not record the field at all, and it is
what a stranger who sends no header carries too. A rule that read absence as "one of ours" would
mark all three. Absence is never a reason to mark a row.

**One dated clause, for the rows already written.** The rows in the live ledger from before this
shipped carry no marker and will not age out on their own, because the file is small against its 5 MB
rotation cap. So they are read through one bounded exception: the instance door only, refused or
locked only, a user agent of exactly `node` or empty, the operator-address test above, and a
timestamp earlier than the cutover constant stamped in the code the day it shipped. It is dated on
purpose. It cannot grow, it stops mattering as the old rows rotate out, and the comment beside the
constant says why it exists so that nobody later mistakes it for a rule.

### Which gates get labelled, and what an unlabelled burst means

Four scripts reach a live login door and all four send the header: `verify-deploy`,
`verify-one-console`, `verify-one-console-browser` and `verify-control-plane`. Every other
`scripts/verify-*.mjs` -- 42 of the 46 as of 2026-09-09 -- either never posts a password anywhere or
posts one to a fixture server it started itself, so it writes no row in anybody's ledger. Anything
that grows a login leg later gets the header with one import, from `scripts/gate-agent.mjs`.

**An unlabelled burst is not automatically a stranger.** Two shapes of ours are unlabelled and both
are on the R750 today:

- **rows written before 2026-09-09 18:00 UTC**, which is when the header shipped. Measured on the
  R750 at 22:40 UTC that day: over the last day 147.136.44.142 shows **131 attempts, 39 refused, 65
  locked out, 27 that worked and 28 different passwords**, and **22** of those attempts are marked
  as ours: **11 named by the header** from the 19:39 UTC deploy-gate run, **11 matched by the dated
  clause**. The rest are earlier deploy-gate runs from before the header existed, they carry agent
  `node` or nothing at all, and they are what keeps the Attack pill lit on that address.
- **rows written by the control plane's own door**, which records no user agent at all. See below.

So when you see a burst on your own address: check the times against your own ship log before you
treat it as an intrusion, and check whether the addresses and the accounts named are ones you know.
The panel deliberately will not make that call for you any more.

**What the ship measured.** On the R750 on 2026-09-09, `verify-deploy --url
https://console.titanium.bot` put eleven login and lockout rows into the relay's ledger carrying the
exact agent `titanbot-gate/verify-deploy`, so the relay records the header with no relay change at
all. Under the first shape of the rule not one of them was labelled, because the deploy gate holds no
password on purpose -- it is let in by the gateway bearer, which writes no ledger row -- so it could
never produce the successful operator sign-in that rule asked for, and the 11 grey rows on the panel
that day were the dated clause's rows at a different hour entirely.

With the label no longer deciding anything, that second test is gone from the header clause and a
named row is named on its own evidence. Measured on the R750 at 22:40 UTC on 2026-09-09, in a real
browser at 1440x900: all **11** rows carrying `titanbot-gate/verify-deploy` read as gates and say
**"says it is our own verification gate (verify-deploy)"**; **11** more read **"an older row, from
before gates named themselves"**; the strip says **LOOK LIKE OUR OWN GATES 22, counted like
everything else, marked in grey below**; the sentence under the filters splits the two clauses by
name; and **ATTACKS still reads 1** on that same address, with its row carrying "22 of them look
like our own gates, and are counted above" beside 131 attempts and 28 different passwords. That last
part is the point: the label is now visible and free.

### The rows this can never label, and why that is right

**Rows written by the control plane's own door carry no user agent at all, so they are never
labelled as a gate and can never be silenced by one.** That service's `login_attempts` table has no
column for it: it is not recorded on the way in and the panel is handed a hardcoded empty string on
the way out. `scripts/verify-control-plane.mjs` sends the header anyway, because the line costs
nothing and is right the day the column lands, and the migration is filed as **SIGNIN-1b** rather
than left as a comment.

Read plainly, that is a gap in the labelling and a floor under it. A sign-in posted straight at
`api.titanium.bot`, which is the path that never touches a customer's console, is the one an
attacker is most likely to use, and it is exactly the path where this label does not apply at all.

---

## The rail, panel by panel: what each one controls and where every number comes from

Jason, 2026-09-09 12:13: "I think we're going to have to turn that into more of a dashboard
left-hand nav, your standard dashboard, because stuff is all jumbled and there is a lot of
scrolling." It was one long page with eight panels stacked down it.

So there is a **left-hand rail with nine entries and one panel on screen at a time**. The URL hash
names the panel, so a link opens the panel it points at and the browser's own back button walks
where you have been. Each panel carries its own summary strip and scrolls inside itself rather than
scrolling the page. The rail entries are ordinary links, so Tab and Enter reach every one of them
with no keyboard handling of our own.

The nine, in rail order, are **Overview**, Sign-in attempts, Clients and users, Box health, System
health, Spend, Providers, Feedback and Marketplace. Overview is new and is a summary of the other
eight; the eight themselves are the same panels with the same buttons on the same routes, moved into
a rail rather than rewritten.

Every number carries the moment it was measured. Anything that could not be measured says **"not
measured"** and why, and never a zero, a dash, or a green tick. That rule is the reason the Overview
below is a summary and not a scoreboard.

**Measured on the R750 2026-09-09 19:40 UTC**, from this Mac in headless Chromium at 1440x900
against the live console with three tenants, three provider cards, four plan models and live
feedback rows behind it: all nine panels were opened by their hash and every one measured
`document.documentElement.scrollHeight` **900** and `scrollWidth` **1440**, with the open panel's own
`scrollWidth - clientWidth` at **0**. The body does not scroll, in either direction, on any panel.
For scale, the same content as one long column measured **4,021 px** against a one-workspace control
plane on a Mac and **8,403 px** at 1400 wide against the gate's populated fixture.

Two things do scroll on purpose and should: a panel taller than the window scrolls **inside itself**,
and a wide table scrolls **inside its own box** rather than widening the panel. On the R750 the
provider key table is 1,534 px wide in a 1,128 px panel, so its last buttons sit past the right edge
of the box and come into reach by scrolling that table. That is the intended shape, not a defect: the
alternative is a page that scrolls sideways, which is the thing the rail exists to end.

### Overview

**Controls: nothing.** It is the only panel with no action on it, deliberately. It answers "what
needs me this morning" and then sends you to the panel that can do something about it.

Six chips, each one a link into the panel it came from: clients running of total, boxes healthy of
total, spend this month, reports waiting, rows needing re-verification, and sign-in attacks in the
last day with this repository's own gates left out.

**No chip has a source of its own.** Every number on it is already in one of the eight answers the
page fetches, so each panel registers its own headline as it loads and the Overview draws what it is
given. There is no ninth request, and there is deliberately no Overview API route in front of these
chips: a summary computed somewhere else is a second answer that drifts from the panels the first
time either side changes.

**A chip whose panel could not load reads "not measured" with the reason on it.** Never a zero and
never a tick. A dashboard that shows a green light for a number it failed to fetch is how an outage
gets missed, and the top of the console is the worst place in the product to start doing that.

### Sign-in attempts

**Controls: nothing; it is the panel you read before you act on another one.** What it changes is
what you do next: an address worth blocking is blocked at the edge, and a person worth stopping is
stopped from Clients and users.

Both ledgers, merged, and three tables over the same rows.

**By address** gives you tries, refused, locked out, signed in, the accounts that were named, and the
sentence that matters: "the same password 4 times" or "6 different passwords". The Attack chip
appears on an address that meets the attack rule above.

**By account** is the same window lined up by who was being guessed at instead of by where it came
from, and the Spray chip appears there. It is a separate table rather than a column because a spray
has no address to sit under: it arrives from a hundred of them and each one looks harmless. An
account whose only rows came through a customer's console reads "through the console" instead of an
address list, for the reason in the merge section above.

**Every attempt** is the rows themselves. Filters for the window and the outcome are at the top; the
"Seen by" column says whether a row came from the console or from this service.

**This repository's own verification gates are greyed rather than hidden, and counted rather than
excused.** A row marked by either clause in "Telling a gate from an attacker" above reads "says it is
our own verification gate (verify-deploy)" in grey -- or, for the dated clause, "an older row, from
before gates named themselves" -- stays in Every attempt, and is counted on its own line in each
summary beside the number it is part of. It stays in the Attack pill and in the distinct-password
counts, because the header that names it is a string anyone can write. An address that has also
signed in as an operator or a super admin within the hour reads **"your address"** beside it.

### Clients and users

**Controls: this is where a customer starts and where they are stopped.** Add a client. Stop, start,
restart or rebuild a workspace. Turn a person's sign-in off, back on, or reset their password. Set
which plan model that workspace runs on and how many bots it may hold.

#### Add a client

Jason, 2026-09-10: *"Is the super admin panel ready in a state where I can invite a user and it will
handle the full onboarding process, including creating the account and workspace, creating a Docker
container for the AI agents, setting up their emails? Is the entire process ready? Is the welcome
email sent out?"*

It is now. One form: the person's name, their email, the company, which plan model their workspace
runs on, how many bots it may hold (40 by default), **send the welcome email** which is on by
default, and, only when that is on, an optional address to send the welcome to instead of the owner.

**One press, five named steps.** The press answers immediately with the account, the workspace and
the temporary password, and the card below it fills itself in:

1. **Creating the workspace** -- the account row and the workspace row. Every refusal happens here
   and creates nothing at all.
2. **Building the computer** -- the eight provisioning steps, then the box's own `GET /health`
   answered with that workspace's bearer. **Coolify saying the container is running is not enough**
   and never turns this green: a created container is not a booted host, and a welcome sent on that
   evidence reaches a customer whose workspace will not open. Ten minutes at three second intervals,
   because a server that has never pulled the image takes longer than any provisioner's ceiling.
3. **Waking Titan** -- the plan model is pushed **first**, then the ceiling, then the model is read
   back off the relay, and only then is the box read. The order is not cosmetic: a new box gets
   `{"SAND_BACKEND_URL":""}` written into it, so a box nobody pointed at a model has Titan awake and
   mute. If nothing reads back the step goes amber and **the job stops before the welcome**, saying
   *"Titan is up but has no model yet, so he would not answer."*
4. **Giving the agents their addresses** -- the relay's address sweep, asked for **this workspace**
   rather than the fleet. A 503 is *a sweep is already running* and is retried, never a failed
   onboarding. The 200 is not the signal: what turns this green is a live row for that workspace in
   this service's own directory, and Titan's address is read here and goes into the mail.
5. **Sending the welcome** -- the mail, from the product's own address, with the send recorded on the
   customer's row.

A step is one of **waiting**, **working**, **done**, **needs you** (done with a caveat, or stopped
where a person can act) or **stopped**. Amber and red both offer **Retry**, which resumes at the
first step that is not done rather than building a second box beside the first. A step that has
written nothing down for three minutes reads as stalled and offers the same Retry -- that is what a
control plane restart mid-invite looks like from the outside. **Nothing is ever half-green:** an
amber step is a step somebody has to look at, even when the one after it could have run.

**The state lives in the provisioning ledger, not in memory.** A control plane restart mid-invite
loses the runner and loses nothing else. Reload the page and the card rejoins; the poll route is a
pure read.

**Why the press answers before anything is built.** This console is behind Cloudflare, which cuts a
proxied request at about 100 seconds (measured 2026-09-10). A synchronous invite that waited for a
cold box, a model push, an address sweep and a mail send would time out with a half-built customer
behind it **and the temporary password lost with the response**, on the one screen where losing it
costs a customer their account.

**The temporary password is in the first answer and nowhere else.** It is minted, shown once on the
card, and stored the way every other password here is stored, as a scrypt hash nothing can ask back.
The card draws it **always**, whatever happens to the box, the model, the addresses or the mail. If
it is lost before it reaches the person, reset it from their row, which mints another and shows that
once too. **Copy the welcome note** puts the sign-in address, their email and that password on the
clipboard as plain sentences.

**The welcome email**, and the field beside it. It goes from the product's own address on the
operator's domain, carries a sign-in link **and** the temporary password, and names Titan's own agent
address. The link is **good for 24 hours, works every time it is clicked, and cannot be cancelled**
-- it is a stateless bearer credential in a URL and the relay checks no revocation list (measured on
this Mac 2026-09-10: one link verified at +1 s, +2 s and +23 h, refused `expired` at +24 h 1 min, and
minting a second left the first working). Call it one-time when ONBOARD-3/ONBOARD-5 land a link that
is consumed once, and not before. Replies come back to `mail.welcome.replyTo`, which defaults to
`support@titaniumcomputing.com` -- a domain that already receives, because a reply address nobody
reads is worse than one on the parent company's brand. Change it in one line:

```sh
node cp/cli.mjs settings set mail.welcome.replyTo help@titanium.bot
```

The **send the welcome to a different address** field is an **override and not a copy**. When it is
filled in the mail goes there and **not** to the owner, and the card and the row both say so. There
is no bcc anywhere in this path on purpose: a copy would put a live sign-in link and a temporary
password for somebody's workspace in a third party's inbox until the link expires, and that link
signs its holder in.

**The refusals are the sign-up sequence's own sentences, word for word**, because two doors that
refuse the same thing in two different sets of words are two doors that will drift: an address that
already has an account, a company name that yields no usable workspace name, a workspace name already
taken or held back after a previous customer was removed, and new tenants being switched off on this
install. Nothing is created when any of them fires: no account, no workspace, no box.

The CLI stays as the second door and runs the same sequence:

```sh
node cp/cli.mjs signup add <email> <company>
```

#### Send again, and a sign-in link

Every welcome that goes out is a row on the customer's own row: who sent it, who it went to, when,
the outcome and the provider's id. There is no link and no password in that record.

**Send again** mints a **fresh** link and leaves the password alone, because the original is a scrypt
hash nobody can ask back and changing it would lock out a customer who has already signed in. Tick
**with a new password** and it resets the password and includes it, which is the same reset the
person's own row offers; the new one is shown once in the banner and the row records which of the two
shapes went out. A double press inside the hour cannot mail a real human twice.

**Copy a sign-in link** is the recovery when a welcome bounced. Understand what it is: a stateless
bearer credential in a URL. The relay verifies it with that workspace's own key and **never checks it
for revocation**, so it works as many times as it is clicked until it expires and cannot be cancelled
short of rotating `CP_SESSION_SECRET`, which signs the whole fleet out. Twenty-four hours is a
ceiling and not a target. It is answered once, put on the clipboard, and written to no row, no log
line and no screenshot. Send it the way you would send a password. **ONBOARD-5** is filed against it.

#### Remove a client

**Remove** is on the customer's row, behind three gates, and they are not ceremony. Click again to
confirm, then the workspace name typed to match, then a **delete their data** switch that is OFF by
default. A typed name that does not match does **nothing at all** -- not a stop, not a disable.

What it does, in this order, each one a step in the ledger and one row in the record of who changed
what: every sign-in for that workspace is disabled first so nobody can get in during the teardown;
every one of their bots' addresses is retired, because nothing else ever will (the sweep only retires
codes for a roster it could read, and it cannot read a box that no longer exists, so a removed
customer's addresses would keep routing for ever); their key at the proxy is revoked **before** the
container, because a box that is up and cannot reach a model is visible and a box that is gone and
can is not; the service is stopped, then deleted; and then **the container is proved absent**.

That last step is the one that matters. Coolify's delete answers `200 Service deletion request
queued` and dispatches the real work later, and the remote half of that job is wrapped in a catch
that logs *"Remote cleanup failed, continuing with local deletion"* and deletes the local record
anyway. So the failure that costs the most -- Coolify forgetting the service while the container
keeps running with the customer's gateway token -- **answers 200 and looks like success**. The
removal polls until the container name is really gone and records which proof it rested on. If
neither proof arrives it **stops there**, the workspace row is not deleted, and the card says
*"Coolify took the record and the container is still running"* with the command that finishes it.

The data switch, and what the card says when it is off: **their files are kept and nothing deletes
them on a timer.** There is no reaper in this product, nothing counts days, and a card promising
thirty of them would be the product lying to the operator. **ONBOARD-4** is filed for a real one. With
the switch on, the deletion is done by the relay and not by this service, because this service runs
as uid 1001 and a tenant's volumes are 0700 owned by uid 1000: it physically cannot, and a route that
pretended otherwise would report a success that never happened.

Finally the accounts are deleted and the workspace name is released, so the name is genuinely free
again. The accounts are **disabled at the start and deleted at the end** on purpose: the retirement
exists to stop a new company inheriting a previous customer's sign-ins, and with those sign-ins
deleted there is nothing to inherit.

**What it refuses, with no effect at all:** a workspace that does not exist, an **adopted** one (which
is what makes it impossible to remove `titanium`, your own live console, and stopping it first is not
a way round the guard), the operator's own workspace, and a confirm that is not the workspace name.

The CLI twin does the same thing and prints each effect as it lands:

```sh
node cp/cli.mjs tenant remove <slug> [--delete-data] [--yes]
```

`DELETE /v1/tenants/{slug}` still exists in `cp/server.mjs` and is untouched. That is the low-level
door for a workspace that is already stopped: it takes the row out and does none of the nine things
above. **Remove** is the one to use for a customer.

#### The cards

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

**How many bots a workspace may hold, on its own row (AGENTS-CAP-2).** Jason, 2026-09-09: the
default is 40 and the super admin raises a workspace's ceiling from its client row. Forty because
flat coordination holds to about that many and the hierarchy tooling does not exist yet; a power user
who wants a hundred asks, and this is where they get it.

**The number is READ off the box every time this panel loads and is stored nowhere here.** There is
no ceiling column in the control plane, deliberately: the number that decides whether a customer can
add a bot is `SAND_MAX_AGENTS` in that box's own `sand-host-settings.json`, resolved by the host on
every turn, and a copy kept here would be a second answer that drifts the first time anybody edits
the file. So each row asks the relay, which asks that box's own `getAgentCapacity`.

The row has three states and no fourth, exactly like the model row above it:

- **not measured**: the box could not be asked, with the reason on it. Never a zero and never the
  default, because "we could not look" and "this workspace holds forty" send you to different places.
- **pinned**: the container environment sets `SAND_MAX_AGENTS`, so the box answers through that
  whatever is written into its file. A chip and no control, because a field that writes a file the
  host then ignores is worse than no field. Recreate the box without it to unpin.
- **settable**: a number and a Save.

A write is a read, a merge and a write of that one file, with the value as a **string**: the host's
settings reader takes a value only when `typeof value === "string"`, so a ceiling written as a number
is silently ignored, and the file also carries `SAND_TOOL_TRACE` and `SAND_SELF_TALK_CAP` on the live
boxes, which a one-key write would truncate away. The range is checked in the control plane before
the relay is called, because **the host fails open**: anything outside 1 to 1000 drops that workspace
to the product default with nothing on any screen saying why.

**The answer names what the box read back, never the number that was sent**, and a pinned box reports
a pin rather than a success. That is the same rule the model row keeps, for the same reason: a door
that reports a write it knows cannot take effect lies quietly, which is worse than one that refuses.

**Measured on the R750, 2026-09-09.** Before the bundle landed, all three boxes were read read-only
and each held `"SAND_MAX_AGENTS": "100"` as a string with `printenv SAND_MAX_AGENTS` empty, which is
what made the product default coming down to forty safe: it cannot reach a box that pins its own
number. After both host swaps all three still answered `maxAgents 100`. The clients panel then read
100, 100, 100 off the three boxes; the demo row was set to 40 and answered **`maxAgents 40, pinned
false`, which is the number the box read back and not the number that was sent**; the demo box's
settings file afterwards is `{"SAND_TOOL_TRACE":"1","SAND_SELF_TALK_CAP":"2","SAND_MAX_AGENTS":"40"}`
at mode 0600, so the merge kept its neighbours and wrote a string. Signed in at
https://console.titanium.bot as the demo customer in a real browser, the header reads **`2 / 40
bots`** with **`1 of 39`** on the Add tile. Jason's row and Richard Avery's row were read and never
written and still read 100.

**Making `gh` work inside a workspace is one paste, on this same row's box (GH-1).** The GitHub CLI
is installed in every box and reads a token out of the environment or out of `~/.config/gh`. It reads
neither by default, so `gh auth status` answers *"You are not logged into any GitHub hosts"* and the
agent reports it as a fault. The remedy is the box's own shell store, not this console and not an
environment variable: `setShellSecret GITHUB_TOKEN <value>` through that box's gateway, after which
every agent shell -- the window daemons' shells included -- carries `GITHUB_TOKEN`, which is the name
`gh` itself says it reads ("Failed to log in to github.com using token (GITHUB_TOKEN)", measured in
the box), and `gh` is signed in. **It survives a host swap** (the shell store lives in the box's data directory, and
`persist-cli-auth` carries `.config/gh` across one) and **is lost on a container recreate**, which is
the same rule every other in-box credential follows. Measured read-only inside the demo tenant's box
on the R750, 2026-09-09: `gh` 2.46.0 present, `GH_TOKEN` and `GITHUB_TOKEN` both empty, all three
possible `~/.config/gh` directories absent. The paste is an operator action nobody has taken yet and
is tracked as **GH-1b**.

**Neither button closes a session that is already open**, and reset password is the one where that
matters, because it is the button you reach for when an account is compromised. The old password
stops working the moment you press it. A session token that person is already holding keeps working
for up to twelve hours, because a session is signed rather than stored: the relay checks the
signature and the expiry with that workspace's own key and there is no revocation list on that path
at all. Both messages on screen say so. If somebody hostile is inside an account right now, resetting
the password is not the whole answer; stop that customer's workspace from the Clients panel, which
takes the box away from anybody holding a session for it.

### Box health

**Controls: nothing.** Every button that acts on a box is on Clients and users, one row per
customer. This panel is what you read to decide which of them to press.

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

**The sweep is bounded, and it is run once per refresh.** It is real work on the host: `docker
inspect`, `docker stats` and `du -sk` for every customer, in sequence. Two things follow. It gives
itself an eight second budget, and a customer the budget did not reach says so by name rather than
holding the whole report past the control plane's patience and taking every other customer's row
down with it; `du` on the slow one is cut to whatever is left. And the relay answers every ask
inside a five second window from one sweep, because a single click on Refresh loads this panel and
System health together and both want the same answer. The control plane waits fifteen seconds for
it, which is longer than the budget plus the trip; `CP_RELAY_TIMEOUT_MS` moves that.

### System health

**Controls: nothing.** It is the one panel about the machine rather than about a customer, and four
of its cards are honest holes rather than lights. See "What is not measured" below for each one and
what would fill it in.

| What | Where it comes from |
|---|---|
| Host load | `/proc/loadavg`, which is not namespaced, so it is the machine |
| Host memory | `/proc/meminfo`, same |
| Free on `/data/titanbot` | `statfs` on the bind mount |
| Coolify reachable | a live `GET /projects` against the api |
| Relay reachable | a live call to the relay's admin route |
| Control plane version | the service's own `CP_VERSION` |
| Builds that never finished | the provisioning ledger: `provisioning` for more than 15 minutes |
| Sign-in record | whether this service can sign the record at all, checked live |
| Sign-ins in the last day | the control plane's own record |
| Mail webhook | **not measured** |
| Nightly backup | **not measured** |
| Box isolation check | **not measured** |
| Free on the archives mount | **not measured** |

The Sign-in record card is there because "no attacks" and "the ledger cannot hash" look identical
everywhere else. The keyed hash needs a 32 byte salt kept `0600` in this service's data directory; a
directory it cannot write means every refused sign-in is stored with no hash, every address reads "no
password reached the check", and nothing is ever flagged. The card asks for the salt live, which
makes it if it is not there yet, and says whether the record is being written and why not if it is
not. The failure also goes to the container log with the path in it, and it is retried on the next
sign-in rather than remembered for the life of the process.

#### Waking a phone, and Keys the product uses

Two blocks at the foot of this panel, both **write-only paste forms** and both appended in script
rather than written into `cp/admin/index.html`. The first is the two push credentials (PUSH-1). The
second is KEYS-1, added 2026-09-10, and it is the reason no customer in this product ever sees a key
field again. Jason, looking at a customer's settings panel that day: *"A user is never going to put a
resend key in. That's on the backend."*

| Row | What it is | Without it |
|---|---|---|
| Talking, xAI | the realtime key for the first voice service | pressing Talk on that service says voice is not switched on yet |
| Talking, OpenAI | the realtime key for the second | the same, for a workspace set to that one |
| Sending mail | the key every bot's outgoing mail is sent with | the relay keeps using the operator's own file (docs/MAIL.md §1a) |

The rules, which are the same three the push forms and the repository token already live by, and are
printed on the forms themselves:

- **Proved before stored.** One cheap authenticated GET against the vendor, ten second timeout. A key
  the vendor refuses is `409` and **nothing is written**. A vendor that cannot be reached is a refusal
  too: storing a key that could not be checked is the same as not checking.
- **Nothing ever comes back.** The answer, the change record row and the line on this page all carry a
  length and eight hex characters of a sha256, which is the same string the record keeps for ever. The
  field is cleared on the way **out**, so a failed request leaves nothing in it either. Every one of
  the three names is in `SECRET_SETTINGS`, so `listSettings` hands back `""` with `redacted: true`.
- **One reader, and it is not a box.** `GET /v1/relay/keys`, behind `CP_RELAY_TOKEN`, method
  refusal first so a wrong method charges nobody. The relay holds them in memory, refreshes every five
  minutes, keeps its last good copy through an outage, and never writes one beside a state file or
  pushes one into a container — every exec daemon in a customer's box runs as uid 0, so a key inside
  one is readable by that customer's own agents.

**Vendor names are allowed on this block and nowhere a customer can read.** This is the operator's
screen and he has to know which account a key came from.

**The inbound mail signing secret is deliberately NOT here.** It is a routing discriminator rather
than a vendor credential — when two workspaces claim one mail domain, the one whose secret verifies
*this body* gets the message — so one global value would let the first claimant read another
customer's mail. docs/MAIL.md §1a is the argument in full.

### Spend

**Controls: nothing yet, and two things that should be here are still CLI lines**: revoking a
customer's inference credential and minting them a new one, both named at the end of this section.
Payments are a placeholder paragraph on this panel and nowhere else.

Per client, this month and today: requests and dollars, one row per customer, read from the proxy's
own spend API through the master key the control plane already holds. The handle is the virtual key,
`key_alias` `titanbot-<slug>`, so a row is a customer by construction and cannot be attributed to
the wrong one by an address or a header a box chooses. Spend to date comes from `/key/info`; the two
windows come from `/global/spend/report` grouped by api key.

A plain chip at 80 percent of the plan's allowance, and a stop at 100. **Observe mode is the default
this wave**: allowances are recorded and nothing is enforced until `CP_PROXY_ENFORCE` is set, so the
number appears here before it can ever refuse a customer's turn.

Four sentences on this panel that are honesty, not decoration, and they are on the page as well as
in this document:

- **Spend is batch-written**, every 10 seconds. A number read immediately after a burst reads low.
- **The TinyFish column counts requests, not dollars.** It is metered at a flat cost per request,
  because the pass-through cannot see TinyFish's own pricing.
- **That column also counts REST calls only.** The proxy's MCP mount does not meter (PROXY-4,
  measured on this Mac 2026-09-08), so a customer's browser automation runs through a route this
  panel cannot count.
- **The 100 percent stop is a stop, not an exact cap.** The counter chain can read stale-low, so a
  customer may go slightly past their allowance before it lands.

Two actions belong on this panel and are not on it yet: revoke a customer's inference credential,
and mint them a new one. Until they are, both are `cp/cli.mjs proxy revoke <slug>` and
`cp/cli.mjs proxy mint <slug>` on the R750, and `docs/OPERATOR-RUNBOOK.md` carries them.

Payments stay where they were: "Not connected yet. Plan and billing appear here when Stripe is
wired in."

### Providers

**Controls: every provider key on the system, and which model each plan runs.** Add a provider, add
a key to a pool, roll one, remove one, remove a provider, refresh a vendor's model catalog, set a
plan model's vendor model, context window, customer label and price, and push a label to the
workspaces on it. This is the panel Jason's second question was about: the keys and the models are
here, and the GitHub token is on Feedback.

The panel that ends the hand operation. Before it, adding a provider, adding a second key to a plan,
rolling a key or repointing a plan alias were an ssh, an edit of
`deploy/coolify/proxy-config/config.yaml` and a proxy restart, which is about 20 s of failed turns
for every tenant on the machine, for a change that has nothing to do with any of them.

Four things it holds, and where each number comes from:

| what | source | what it is not |
| --- | --- | --- |
| providers: name, kind, base URL, health | the proxy's own deployment records | not a file on disk |
| a provider's keys as a pool: add, roll, remove, order, per-key spend, last error | the proxy's credential store, masked on read (`sk****AA`); spend from its spend log | the control plane holds no key value at all |
| plan models: alias, vendor model, vision fallback, context window, customer label, plans | the proxy's deployment `model_info`, where the product's own `tb_*` fields ride | the alias is a contract with every box already pointed at it and is never renamed |
| a per-provider model catalog, with Refresh | the vendor's own `/models`, read directly at the moment a key is added, rolled or pasted into Refresh, and the names stored | **names and only names.** Context window, vision and the customer label are facts a human sets, and the page says so in those words |
| a price per input and output token on each plan model | typed in, written into the deployment's `litellm_params`, which is what the proxy bills from | LiteLLM carries no price for a Z.AI or Alibaba model id, so an unpriced model reports **not priced** everywhere rather than $0.00 |
| how many boxes are behind on the name their Titan says | each tenant's own `box-secrets.json`, read off `/data/titanbot` | not a guess and not a null: a red chip counts the boxes whose label is not the plan model's |

**Five rules this panel is built on, each of them a defect it used to have.**

1. **A key is proved before it is stored, and before a serving slot is patched.** The add and the
   roll both ask the vendor first and refuse with the vendor's own sentence. Measured on the R750
   2026-09-08: an unchecked swap 401s on the very next request 0.3 s later and then puts the
   deployment in the router's 30 s cooldown, with the old value overwritten in place.
2. **A vendor key is never persisted anywhere but the proxy's encrypted credentials table.** The
   catalog is read directly, holding the key for that one request. The pass-through this used to go
   through stored it in `LiteLLM_Config` in cleartext and handed it back unmasked.
3. **Health has three states and one of them is "not checked".** Nothing on this install checks in
   the background, so a green light is either real traffic with no failures inside the window or a
   *Check now* somebody pressed. It used to be `true` always, with a fresh timestamp on it. **The
   red one means the LAST requests, not the month**. See "What the health chip means" below, which
   is the rule that replaced a chip reading "not answering" beside a provider that was answering.
4. **Which workspaces run a model is joined on the deployment id.** The spend log records the VENDOR
   model, so matching the alias against it hid two live customers, one of them paying, from the
   guard that refuses to delete a model people are on.
5. **Pushing a label always asks which workspaces.** The relay door it drives writes seven names
   including the model, so a push moves a workspace onto that plan model. The page sends an empty
   request, renders the candidates the route answers with, and posts only what the operator ticked.

**The ledger is never pruned, and that is said here so nobody trims it later.** `admin_actions`
records who changed what, when, and from which address, for every change made on this panel. Sign-in
attempts are pruned at 30 days because they are noise after that; "who changed the plan model in
March" is a question asked in June, so this table keeps everything. No key value ever reaches a row:
names, lengths and sha256 prefixes only, and a test plants a key value and asserts it does not
appear.

#### What the health chip means

Jason sent a screenshot on 2026-09-09 of a provider drawn as **not answering** that was answering
perfectly well: measured on the R750 at 12:02 CDT, a chat request through that provider came back
HTTP 200 in 2,357 ms. The chip was red because the rule behind it was "any failure this month", and
the month held three failures out of a couple of hundred requests, all of them from the day before,
all from before its key was moved to a different endpoint. A provider that failed three times
yesterday and has answered every time since read "not answering" for the rest of the month, while
the key row beside it said "LAST ERROR none", because that column was reading a different source
that is always empty on this install. Two contradictory signals on one card, both wrong.

**So the chip is about the last requests, not the month.** It is red when the most recent five
requests on that provider **all** failed, or when a live check somebody pressed failed and has not
expired. Otherwise it is green, and the month's failures are kept beside it as an amber count, in
words: "3 of 220 failed this month, last 2026-09-08 22:48 UTC". The history is not hidden, it is
just no longer pretending to be the present.

**Red also needs a sample deep enough and fresh enough to be about now.** At least three of those
recent requests, and the newest of them no more than two hours old. Below either, the chip reads
"not checked" with the reason rather than red -- and never green. Measured on the R750 at 22:40 UTC
on 2026-09-09: MiniMax's entire recent window is **one request, from 2026-09-08 23:40 UTC**, and
nothing else is ever run through it. Without the floor, one unlucky request would have painted that
card "not answering" until the calendar month rolled over, on a sample of one, with no traffic
coming to change it. The amber month count carries those failures either way. The two cases are
held by tests on this Mac -- one failure alone, and four failures a day old -- because they cannot
be made to happen on the R750 without breaking a provider somebody is using.

**The key row's LAST ERROR reads the same request log** as the chip, so the two halves of a card can
no longer disagree. Empty means the log holds no failure for that key's slots, not that nothing was
looked at.

**Check now with no key pasted says it needs the key**, rather than sitting silently beside a red
chip as though it had been pressed and failed.

#### Remove a provider

A provider card carries a **Remove** control, and it is enabled only when that provider holds no
keys and serves no deployment. This exists because the recovery of 2026-09-08 left a duplicate
behind: two cards with the same name and the same endpoint, one of them with no key and nothing
ever run through it. There was no way to take it off the screen except editing the store by
hand, which is the kind of hand operation this panel exists to end.

Removal asks you to type the provider's own name back, because a provider is not a row you can put
back by pressing undo.

**A built-in provider comes back.** The presets ship with the product, so removing one takes away
this install's copy and the preset itself returns as an unconfigured card the next time the list is
read. That is the intended behaviour and it is why the refusal below exists: if the preset carries
an override, meaning an endpoint or a model list you set on top of it, removing the provider would silently
throw that away and leave a card that looks the same and behaves differently. So a preset with an
override is refused unless you say explicitly that the override goes too.

The same from the CLI, which writes the same change record:

```sh
node cp/cli.mjs proxy providers remove <id> [--and-override]
```

**The customer half of this panel is `docs/PROXY.md` §6a–6d**: what a customer reads instead of the
routing alias, how they pick a model on their own provider, the three clocks a change runs on, and
what they see while you roll a key (nothing).

**The R750 measurements for this panel (adding a second key, rolling one with no failed request,
repointing an alias and back, a catalog refresh, per-key spend and the ledger rows) belong in this
section and come with the proxy and console items of this wave.** Nothing above is a measured number;
it is what the panel is for.

**MEASURED ON THE R750 2026-09-08, 19:33Z to 20:00Z**, every one of these from this console's own
routes with the admin token, from inside `titanbot-cp`:

| what was done | what came back |
| --- | --- |
| a second key added to the MiniMax pool | `minimax-2`, pool of two. The value is the SAME SUBSCRIPTION as `minimax-1`, because only one MiniMax subscription exists: two entries, one subscription behind them. It proves the mechanism, not the redundancy |
| a Z.AI key rolled | **0.26 s**, the slot's mask moved to the other subscription's mask and back, the pool never changed shape, and a request every 500 ms through that pool recorded **zero failures** |
| `plan-zai` repointed to `glm-4.7` and back | the proxy's own request log: `glm-5.3` 19:52:06, `glm-4.7` 19:53:22, `glm-5.3` 19:53:37, same deployment ids. Next request, and next request literally, because `--num_workers 1` is pinned |
| the Z.AI catalog refreshed | **live**, ten names, through a pass-through that carries the vendor key so this container never holds one. Names and nothing else: no context window, no vision flag, which the page says in those words |
| per-key spend read | 51 requests on `zai-1`, 42 on `zai-2`, the pool sharing load |
| the vision check on `plan-zai` | it took an image part, through the database's own fallback map after the file stopped declaring one |
| the ledger read | 15 rows, one per change, each with actor, time, address and outcome including the roll that failed, and **no key value in any of them**: a key is named by its length and a sha256 prefix |

**The custody path held.** A provider key crosses the browser once, in a POST body, and comes back
out of nothing: no GET answers it, no ledger row holds it, no log line prints it, and the field is
cleared on success. `tests/cp-server.test.mjs` plants a real-shaped key through the panel's own route
and then sweeps every GET route in the file for its bytes; `scripts/verify-admin.mjs` plants two
through the masked field in a real browser and 20 checks confirm neither reaches a response body, a
DOM node, or the control plane's log.

### Feedback

**Controls: what happens to a report an agent sent, and the GitHub token.** Approve, suppress or
close a report, edit its wording, file it as a GitHub issue, and paste the repository token those
issues are filed with. That token is the only secret this service holds rather than passes along,
and the three rules that go with it are below.

Jason, 2026-09-07: "Titan tried to cover up failure. We need to instill in the agents that failure
must be reported... 'Would you like to submit this feedback to the developers?'... it should come in
somewhere and then become a GitHub issue."

**TWO GATES, AND THIS PANEL IS THE SECOND ONE.** Every row here was written by an agent inside a
customer's box, shown to that **workspace operator** in their own console, and sent by that person,
who could edit it, add context to it or drop it first. Nothing reaches this screen around them. What
happens here is the **developers'** decision: file it, suppress it, or close it.

That is topology and not a rule somebody has to remember. The agent's tool posts nowhere: it writes a
pending report into its own box and returns a sentence. The console, already signed in as the tenant,
is the only thing that POSTs. Three things fall out of that shape for free:

- **No control plane credential is ever inside a customer's container.** Both of this service's doors
  are fatal there: `CP_RELAY_TOKEN` reads every tenant's gateway token and derived session key, and
  `CP_ADMIN_TOKEN` deletes services. Every exec daemon in a box runs as uid 0.
- **A box cannot file as another tenant**, because it never names one. The relay stamps the workspace
  from its own registry and `POST /v1/feedback` reads it from the relay's forwarded header. A slug in
  the body is ignored, not refused, because the field is simply not read anywhere on the path.
- **"The operator saw it before it left" is true by construction** rather than by review.

The three **tiers** change how loudly a report is drawn, how it filters and how the digest batches
it, and nothing else. All three pass through both gates.

| tier | what it means |
|---|---|
| critical | blocks work. Counted on the panel the moment it arrives, and drawn in red |
| quality | a rough edge that did not stop the work. Batched into a digest |
| observation | worth knowing later. Sits in the backlog until somebody reads it |

**The states are `new`, `approved`, `filed`, `suppressed`, `closed` and there is no sixth.** A
suppressed report is **kept** with your name and the time on the decision, never deleted: "we looked
at this and it was not a bug" is itself a record. The rows are **never pruned**, the same as
`admin_actions` and for the same reason. Every state change writes an `admin_actions` row.

**A decided report is not filed, and filing an undecided one IS the decision.** Create GitHub issue
refuses a report that was **suppressed** or **closed**, in a sentence naming who decided and when -- 
because filing wrote `state`, `decidedBy` and `decidedAt` over the row, so the suppression the
paragraph above promises is kept would have survived only in `admin_actions` and been gone from the
panel. Reopen it by approving it again if that decision has changed. A report still in `new` files
without a second press: pressing Create GitHub issue is a deliberate act by the same person the
Approve button belongs to. It is written down as the approval it is -- the answer says so and the
change record row carries "filing is the approval" -- rather than left implied. Both legs are measured
by `scripts/verify-admin.mjs`.

**Edit changes the wording, never the evidence.** The title and the body move; the payload the agent
sent stays exactly as it arrived underneath them, and the issue body is built from that payload. So
what lands on GitHub is what the agent reported, with the operator's context beside it.

Where every number on the panel comes from:

| what | source |
|---|---|
| the rows, their tier, workspace, time and state | the control plane's own `feedback` table |
| the counts across the top | every row, **not** the filtered list, so a filter cannot hide "two critical reports are open" |
| the agent, host version and console version | the payload the console sent, clamped on arrival |
| whether a repository token is stored | `admin_settings`, reported as a length and eight characters of a digest and never as a value |
| the fourth filter, when it appears | wave B's verification table, probed at load. Absent rather than empty when that wave has not shipped, because an empty filter reads as "nothing needs re-verification", which is a green light nobody measured |

**The repository token is the first secret this store has ever HELD** rather than passed along, and
three rules go with it. It is **proved before it is stored**. GitHub is asked whether it takes that
token for that repository, and whether that repository has issues turned on at all, and a token it
refuses is not kept. `listSettings` returns it with an empty value and `redacted: true`, so no route
that renders the settings can carry it. And it is **never pushed into a box**: every exec daemon in a
customer's container runs as uid 0, so a super admin's token inside one is readable by that
customer's own agents through `/proc/self/environ`. It lives here rather than at the proxy because
there is no proxy for a repository token to hide behind. `cp/README.md` carries the same paragraph.

**With no token stored, Create GitHub issue prepares rather than fails.** It renders the body,
answers "the issue body is ready; paste a repo token in the Feedback panel and press this again", and
sends nothing anywhere. The door is proven and unfired, and the operator can paste the issue by hand
that day.

The same thing from the CLI, which writes the same ledger rows with `via` reading `cli`:

```sh
node cp/cli.mjs feedback list [--tier critical] [--state new] [--tenant demo] [--since 7d]
node cp/cli.mjs feedback show <id>
node cp/cli.mjs feedback approve|suppress|close <id>
node cp/cli.mjs feedback issue <id>
node cp/cli.mjs feedback digest [--tier quality] [--since 7d]
node cp/cli.mjs feedback github-token <owner/name>
```

`github-token` reads the token off the terminal with the echo off, or off stdin, and prints a length
and a hash. It is never an argument, for the same reason a provider key never is. The **digest** is a
command today and a timer later, deliberately: a digest nobody has read once is not a thing to put on
a schedule.

**The size of a report is a contract with three minters** (the agent's tool, the console's automatic
offer, and the self-test) and with the intake, which for this one route reads up to
`cp/feedback.mjs`'s `INTAKE_BYTES` (96 KB) because a report carries its evidence twice: as the block
of text the person read and edited, and as the structured copy. `cp/feedback.mjs`'s `LIMITS` are the
numbers, every one of them the console's own maximum or larger, and **a field over its limit is
refused with a sentence naming it, never truncated** -- a report cut down to fit reads as a whole one
and sends whoever reads it looking for a step that was never written down. A report at every one of
them at once is **65,671 bytes of JSON, measured on this Mac**, which leaves room under the intake
for the envelope. A console that mints inside them always lands. One that does not is refused by the
intake rather than truncated into a report that reads as complete and is not.

**A report carrying this service's own session secret, admin token or relay token is refused with
"that report carried a credential, so nothing was stored".** That is not a claim that a report can
hold no secret at all: the evidence is built from a conversation, and a conversation can contain
anything an agent ever printed. Those three are the ones whose appearance here would be catastrophic
and are also the only ones this service can recognise. The card the person sees before they press
Send says what will and will not be sent, in its own words, rather than making a promise the product
cannot keep.

### Marketplace

The ninth rail entry, and the one this document never had a section for: the heading above it used
to say eight panels and the numbered subsections stopped at seven. That was not only a counting
mistake in prose. The page's own markup had the same hole: the Feedback section was never closed,
so Marketplace was parsed as a child of it, which is a thing you cannot see until something tries to
hide one panel and takes the other with it. Both are closed now, and this section is the other half
of that fix.

**Controls: what a customer is offered.** It is the catalog behind the bots and plugins a workspace
can install, and the panel is where an entry is added, edited, published or taken back down.

**Its numbers and its behaviour belong to the marketplace work, not to this document.** What this
section is for is the rail: Marketplace is a panel like the other eight, reachable by its own hash,
with its own summary strip and its own scroll, and every button it had before the rail it still has.

## What changed, and how long it is kept

`admin_actions` is a table of its own in the control plane's sqlite, created by `db.exec(SCHEMA)` on
the next open, so it appeared on the R750's existing database with no migration and no ALTER. A row
is written BEFORE the proxy is called and finished after, so a change that half succeeds is still on
the record: the failed roll above is in the ledger as `failed`, which is the point. Each row carries
the time, who (the signed-in super admin's address, or `the operator token` when the CLI did it),
where from, what, which one, a detail, and the outcome.

**These rows are never pruned.** Not at thirty days, not ever. "Who changed the plan model in March"
is a question asked in June, and the sign-in ledger's thirty-day prune is the wrong home for it: that
table has fixed columns, a validated hash and a coerced `via`. This one is a different thing and
lives on its own.

**No key value ever reaches a detail.** A test asserts it: a planted key is POSTed through the panel
and the whole ledger is swept for its bytes.

### The per-agent action ledger, and the lines that predate 2026-09-08 (PROXY-9)

A different ledger, in a different place: `agents/<id>/audit.jsonl` inside a box is the receipt of
what an agent's tools actually did, and its `shell_command` rows carry the command as typed. Until
2026-09-08 that meant they carried the credential the command acted with. Measured on the R750 that
day, one agent's ledger in Jason's box held the operator's TinyFish key twice, in full (44
characters, sha256 prefix `9165ce2daa86`); the demo box scanned clean across 87 ledgers, so it was
one agent's history rather than a fleet-wide spray.

Since that date the host redacts at write time. It reads the box's own two secret stores,
`box-secrets.json` and `connector-env-secrets.json`, and replaces any of their values appearing in a
command or a browser URL with `<redacted:<first 12 of its sha256>>`, so the receipt stays readable, and
the hash stays comparable, so an operator chasing a leaked key can still match a row to a key without
the row holding one. The same redaction runs on the conversation outline's shell rows, which the
console draws, because a ledger-only fix would have left the credential on a screen.

**The lines that already carried one were swept once, on 2026-09-08, by replacement rather than
deletion.** The two rows in Jason's box became `<redacted:9165ce2daa86>` in place: 352 lines before,
352 lines after, 0 occurrences left, and the other two boxes scanned clean. Replacing rather than
deleting is the point: a receipt of what a tool did is worth keeping and the credential in it is
not, and deleting a receipt to chase a key is the wrong trade in the other direction. The sweep
refuses to write if the ledger is appended to while it runs, because it is a live append-only file.

Sweeping is not the fix and was never the fix. A key that has been in a ledger has been readable, so
the answer is to rotate it; the sweep only stops the copy in the receipt from being one more place
it lives.

Only values of 12 characters or more with no whitespace are redacted. Those files also hold a model
name, a context window and a boolean, and redacting `1` or `gpt-4` would mangle every row while
protecting nothing. A secret shorter than that is out of scope by construction.

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

### The four settings

Nothing has to be set for the console to work. These three only fill in holes:

| Setting | Default | What it does |
|---|---|---|
| `CP_RELAY_URL` | `http://titanbot-relay:7777` | Where this service reaches the console, for the sign-in ledger and box health. The default is the relay's compose service name on the shared network, which Coolify keeps as a network alias, so nothing needs setting on the R750. If it is wrong, the Sign-in attempts panel says out loud that the console's own ledger could not be read, rather than quietly showing half the list. |
| `CP_BACKUP_MANIFEST_DIR` | unset | A directory of nightly backup stamps this container can read. Fills in the backup column and the backup card. |
| `CP_ISOLATION_REPORT` | unset | A JSON file `{at, ok, detail}` a box isolation timer writes. Fills in the isolation card. |
| `CP_GITHUB_API_URL` | `https://api.github.com` | Where the Feedback panel's issue door reaches GitHub. Set it for GitHub Enterprise; `scripts/verify-admin.mjs` sets it at its own fake so no run of that gate ever files a real issue at a real repository. Anybody who can set this can already read this service's environment, so it is no weaker than `CP_RELAY_URL`. |

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

Neither does a session token that was *made up*. A session is signed with its tenant's own derived
key, and every tenant relay holds its own key, which means it sits in that customer's Coolify
environment where anybody who can run code in that relay can read it. So a valid signature says
which key was used and nothing about who the person is. The console checks the rest: the account the
token names has to carry the same workspace and the same email address the token itself claims,
which every token this service mints does, and a token whose account id was swapped for a super
admin's does not. Without that check, one customer's own key mints a super admin. The gate measures
it: a token signed with another tenant's key carrying the super admin's account id is refused by
every route, including promote.

### Which guard a route the page calls has to use

**Every route `cp/admin/admin.js` fetches has to be guarded by `admin.requireSuperAdmin`, and never
by `cp/server.mjs`'s `requireAdmin`.**

The two are not interchangeable. `requireAdmin` is a constant-time compare against `CP_ADMIN_TOKEN`
and nothing else. That value lives in this service's environment; a browser has no way to learn it
and never will. What a signed-in person's tab holds is a session token from `POST /v1/sessions`.
`requireSuperAdmin` accepts **either** — the operator's bearer, so the CLI is unaffected, or a
session whose account carries the flag, looked up in the store on every request.

Anything under `/v1/admin/*` gets this for free: `cp/admin.mjs` runs `requireSuperAdmin` once at the
top of `handle` before it matches a path. The routes to watch are the ones that live **outside** that
prefix because `cp/admin.mjs` claims the whole prefix and answers 404 to anything it does not match
itself, so a wave that cannot edit that file puts its route elsewhere. Today that is
`GET /v1/code/tasks` and `GET /v1/voice/usage`.

Getting it wrong does not show up as an empty panel. `api()` in `cp/admin/admin.js` treats **any**
401 as a dead session and signs the person out with "That session is no longer valid. Sign in
again." The Overview loads several panels at once, so one route behind the wrong guard throws the
operator back to the door a couple of seconds after they sign in — which is exactly what
`GET /v1/voice/usage` did on 2026-09-10 (ADMIN-4).

`tests/cp-admin-page-routes.test.mjs` holds the rule: it reads `cp/admin/admin.js`, pulls out every
`api(method, path)` literal, stands this service up in process, mints a super admin and probes all of
them. 400, 404 and 405 pass. 401 fails the suite.

It fails just as loudly, naming the byte offset, if the page calls `api()` in a shape that reader
cannot parse, because a route the sweep cannot see is a route it does not protect. So keep the method
a quoted literal at the call site, in whichever of the three quotes you like, rather than handing it
to the page through a variable or a wrapper.

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
node scripts/verify-onboard-panel.mjs          # ONBOARD-2: the invite and Remove, in a real browser
```

`verify-onboard-panel` drives **the screen** rather than the routes. It stands up this console's own
page and routes against a fake Coolify, a stub relay, a stub box and doubles for the welcome sender
and the removal, then in headless Chromium it opens Add a client, checks the welcome box is on and no
longer disabled, presses Add, watches all five step rows reach done **in order** with no row ever
green while an earlier one was not, screenshots the card at every transition, and then works the
Remove control: the first click arms, a typed name that does not match is refused with **nothing
done**, and one that matches goes through with the data switch carried to the route. It also asserts
the negative that matters: the stub box counts every call it takes, and the sequence made only
`listAgents` and `getOnboardingState` -- **never a prompt**, which would spend a customer's first-run
interview for ever. Measured on this Mac 2026-09-10: **30 PASS 0 FAIL**, the press answering in 89 ms.
The separate end-to-end gate, `scripts/verify-onboard.mjs`, drives the sequence and the removal
against a control plane with no browser at all.

### The one that uses a real console

`scripts/verify-onboard-r750.mjs` runs the whole thing **on a live control plane** and is the only
gate in the tree that creates and destroys a real customer. It is not part of `npm test` and it
refuses to start without being told, by name, where to do it and who to be:

```sh
CONSOLE=https://api.titanium.bot BOSS_EMAIL=<a throwaway super admin> BOSS_PASSWORD=<theirs> WELCOME_TO=<the one real address the welcome goes to> SHOTS=/some/empty/directory node scripts/verify-onboard-r750.mjs
```

Make the super admin with `node cp/cli.mjs account add` then `account promote`, and remove it with
`account remove` when the run is done. **Never a real person's account**: the gate posts a password at
the live door and writes a real row on the Sign-in attempts panel, which is why it says its own name
there through `scripts/gate-agent.mjs`.

What it proves, in order: the console opens; Add a client answers without waiting for the box; the
temporary password is on the card; all five steps reach done with a screenshot at every transition and
the wall clock read off the ledger's own timestamps; the welcome is a send row with a provider id and
**no password and no link in it**; one sign-in link is minted, opened in a **cookie-less** browser,
and lands the customer signed in; the first-run dialog is on their screen and **Titan has said
something on it**, read off the screen rather than out of a gateway call; Titan holds a live address in
the directory; and then Remove with the data switch on leaves the service, the container, the data and
every address gone, the slug free, and every other workspace byte-identical to how it was found.

Two habits it keeps that matter more than any single check. **It never prompts a box** -- every box
read is `listAgents` and `getOnboardingState`, because `onboarding-state.ts` marks a box done for ever
on the first read that finds a prompted conversation and `resetOnboarding` is 403 without
`SAND_TEST_HOOKS`. And **the sign-in link never lands anywhere**: it is read out of a fresh mint, used
once, and dropped, and every screenshot has the password and the link blanked out of the DOM before
the picture is taken.

If the run stops half way, the recovery is the product's own: press Retry on the row, and if it cannot
be finished, Remove it with the data switch on. No hand cleanup on the box -- a hand cleanup means the
product is missing a mechanism, and that is a gap row rather than an ssh session.

It starts a control plane of its own on a free port with a throwaway data directory, a fake Coolify,
a fake relay serving a built-in login-attempts fixture, and a fake GitHub. It needs no box, no docker
and no network. The fixture has three stories in it because those are the three the panel exists to
tell apart: six different passwords from one address, the same password four times from another, and
one ordinary bad morning.

**The page leg walks the rail**: every panel is opened by its own hash the way a pasted link would
open it, every button that was on the page before the rail is still found on it, and no panel makes
the page itself scroll at 1440x900. A panel that can only be reached by scrolling past another one
is the thing the rail exists to end, so it is measured rather than looked at.

**The gates name themselves at any login door they knock at.** `scripts/gate-agent.mjs` builds
`titanbot-gate/<script name>` from the calling script's own filename, and `verify-deploy`,
`verify-one-console`, `verify-one-console-browser` and `verify-control-plane` all send it. The other
gates do not, and that is deliberate: they either serve their own fixture login page, carry a bearer
token, or never reach a login door at all, and changing the user agent of a browser context that
measures rendering would change what the page under test reads for no gain.
`tests/gate-agent.test.mjs` is what keeps the four wired, including the two ways the header is
silently lost: a fetch helper whose caller's headers replace the default instead of merging over it,
and the one leg that uses node's raw https, which sends no user agent unless it is written by hand.

**Nothing in this gate ever reaches api.github.com**, because a gate that filed a real issue at a
real repository every time somebody ran it is a gate nobody runs. `CP_GITHUB_API_URL` points the
control plane at the fake, which answers the way GitHub does for the three cases the door has to tell
apart: a repository the token can see with issues on, one whose issues are off, and a token it
refuses outright.

The fake relay keeps a **per-workspace ceiling** rather than echoing the request back, so a write
really does change what the next read answers. A fake that echoed would pass a control plane that
never called it, and it is also deliberately more hostile than the real relay: it answers `read:
false` **with** a stale number, which is what caught the panel taking a number off a box it could not
ask.

The page leg drives a real headless Chrome. It needs playwright, which
`scripts/setup-gates.sh` installs under `.cache/playwright`; point `GROK_BOT_PLAYWRIGHT_DIR`
somewhere else if yours is elsewhere, or pass `--no-browser`.

Exit 0 every leg passed, 1 a leg failed, 2 nothing was measured.

The unit tests are `tests/login-ledger.test.mjs`, `tests/relay-admin-routes.test.mjs`,
`tests/gate-agent.test.mjs` and `tests/cp-admin.test.mjs`, in `node --test tests/*.test.mjs`. Use
the glob. Several of those were once missing from `tests/index.js`, so the directory form
`node --test tests/` did not run them at all until 2026-09-07; the count in this document's own gap
row was taken with them absent. A new suite has to be added to that list in the same commit, and
`tests/test-index-covers-the-suite.test.mjs` is what makes that safe: it goes red naming the file
when the list and the directory disagree in either direction. Exactly one suite is left out on
purpose, with the reason written into that guard beside it, and adding it anyway is also red. Both
of those legs were confirmed on this Mac on 2026-09-09.

---

## What is next

**AUTH-MFA-1**, the wave after this one, puts passkeys and authenticator codes on the same door.
Super admins will be required to enrol, which is the right order: this console is the account worth
protecting most, and today it is one password.

Stripe fills in the **Spend** panel's billing half. The old line here said "Payments panel" and there
is no such panel: the rail holds Overview, Sign-in attempts, Clients and users, Box health, System
health, Spend, Providers, Feedback and Marketplace, and payments are a placeholder paragraph inside
Spend saying billing is not wired in yet.
