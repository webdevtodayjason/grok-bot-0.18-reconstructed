# The super admin console

ADMIN-1. One person's view of the whole product, at `https://api.titanium.bot/admin`.

Jason, 2026-09-07: "An admin console is merely for a super admin of the entire system... Client
accounts, payment details that we don't have yet, the health of their boxes, the health of this
overall system." And at 15:12: "we should capture tries, users and passwords tried and report in the
Super admin for failures with IP."

Everything on it is read-only except the named actions: stop, start, restart or rebuild a customer's
workspace; turn one person's sign-in off, back on, or reset their password; set what a workspace runs
on and how many bots it may hold; and decide what happens to a problem report an agent sent.

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

---

## The eight panels, and where every number comes from

Every number carries the moment it was measured. Anything that could not be measured says **"not
measured"** and why, and never a zero, a dash, or a green tick.

Five of them are the console as it shipped. The sixth, **Providers**, is what PROVIDERS-1 adds, and
it is the one that takes a text file plus a proxy restart out of the operator's hands. The seventh,
**Feedback**, is what FEEDBACK-1 adds, and it is the only panel somebody else fills in: what the
agents reported and what their own operators chose to send on.

### 1. Sign-in attempts

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
every agent shell — the window daemons' shells included — carries `GITHUB_TOKEN`, which is the name
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

**The sweep is bounded, and it is run once per refresh.** It is real work on the host: `docker
inspect`, `docker stats` and `du -sk` for every customer, in sequence. Two things follow. It gives
itself an eight second budget, and a customer the budget did not reach says so by name rather than
holding the whole report past the control plane's patience and taking every other customer's row
down with it; `du` on the slow one is cut to whatever is left. And the relay answers every ask
inside a five second window from one sweep, because a single click on Refresh loads this panel and
System health together and both want the same answer. The control plane waits fifteen seconds for
it, which is longer than the budget plus the trip; `CP_RELAY_TIMEOUT_MS` moves that.

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

### 5. Spend

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

### 6. Providers (PROVIDERS-1)

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
   *Check now* somebody pressed. It used to be `true` always, with a fresh timestamp on it.
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

### 7. Feedback (FEEDBACK-1)

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
refuses a report that was **suppressed** or **closed**, in a sentence naming who decided and when —
because filing wrote `state`, `decidedBy` and `decidedAt` over the row, so the suppression the
paragraph above promises is kept would have survived only in `admin_actions` and been gone from the
panel. Reopen it by approving it again if that decision has changed. A report still in `new` files
without a second press: pressing Create GitHub issue is a deliberate act by the same person the
Approve button belongs to. It is written down as the approval it is — the answer says so and the
change record row carries "filing is the approval" — rather than left implied. Both legs are measured
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
refused with a sentence naming it, never truncated** — a report cut down to fit reads as a whole one
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

It starts a control plane of its own on a free port with a throwaway data directory, a fake Coolify,
a fake relay serving a built-in login-attempts fixture, and a fake GitHub. It needs no box, no docker
and no network. The fixture has three stories in it because those are the three the panel exists to
tell apart: six different passwords from one address, the same password four times from another, and
one ordinary bad morning.

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

The unit tests are `tests/login-ledger.test.mjs` and `tests/cp-admin.test.mjs`, in
`node --test tests/*.test.mjs`. Use the glob. Both of those files were missing from
`tests/index.js`, so the directory form `node --test tests/` did not run either of them until
2026-09-07; the count in this document's own gap row was taken with them absent.

---

## What is next

**AUTH-MFA-1**, the wave after this one, puts passkeys and authenticator codes on the same door.
Super admins will be required to enrol, which is the right order: this console is the account worth
protecting most, and today it is one password.

Stripe fills in the **Spend** panel's billing half. The old line here said "Payments panel" and there
is no such panel: the eight are Sign-in attempts, Clients and users, Box health, System health,
Spend, Providers, Feedback and Marketplace, and payments are a placeholder paragraph inside Spend
saying billing is not wired in yet.
