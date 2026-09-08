# Titan and the browser (BROWSER-1)

Jason, 2026-09-07: *"Titan should be able to use a browser. If that's been taken away from Titan,
it needs to be given back as a tool."*

It had been. Every box has been running Chrome the whole time, on the person's own profile, on the
screen the console's desktop view shows. Titan could not open a page in it. Asked to read one, he
answered in prose about what the page probably said.

This is what changed, how it is driven, what happens when a page wants a login, and what stays
with the desktop subagent.

---

## 1. What Titan can do now

Four things, in his own hands, no delegation:

| He can | What comes back |
|---|---|
| Open a page | Its title, its address, its readable main text, and one picture of it |
| Click something | What the page looks like after the click, and one picture |
| Type into something | The same, with an option to press enter |
| Take a picture of the page | One picture |

The person never sees any of that. They see Titan say what he found. He is told not to name a
tool, ever, and the copy rule is the same as everywhere else in this product: plain words.

**What he does not do.** Anything that takes ten steps across four pages, filling a form in a
vendor portal, working through an admin console. That is still a job for the desktop subagent,
which owns the whole screen and can take as long as it needs. The rule Titan follows is the size of
the job, not the kind of it: **one page, do it yourself; a long job, hand it to the subagent.**

## 2. The order he reads the web in

Cheapest and most reliable first. The browser is last because it is the slowest and the only one
that can be seen from the outside.

1. **A web fetch.** Most pages answer. It costs nothing and takes a second.
2. **TinyFish.** For a page a fetch could not read. Free, and better at pages that fight scrapers.
3. **The browser.** For the three cases the first two cannot serve:
   - the page refused the fetch outright,
   - the page needs the person's own login and the box's Chrome already has it,
   - the thing that matters is what the page *looks like*.

Fetch and TinyFish are CURSOR-1's half and are documented in
[docs/CONNECTORS-TINYFISH.md](CONNECTORS-TINYFISH.md). Nothing in the browser wave changes them.

## 3. When a page wants a login

This is the case the browser exists for and the one everything else gets wrong.

The box's Chrome runs on the person's own profile, so a site they have signed into once stays
signed in. When Titan opens a page that has not been signed into, he does not guess, does not try
credentials, and does not report a blank page. He says, in plain words, that the page wants a
sign-in, and that the person can sign in on the box desktop through the console's desktop view,
and that he will carry on from there.

That is the whole hand-off. The person opens the desktop view, signs in the way they would on their
own machine, and tells Titan to go again. The login persists, so it is a one-time cost per site.

**One thing an operator should know.** Only the shared seat's profile survives a box recreate.
`/home/box/chrome-profile` is a docker volume; the per-agent profiles beside it
(`chrome-profile-2` through `chrome-profile-10`) sit on the container's own filesystem, so a
recreate wipes them and every site has to be signed into again. That is a real gap, filed as
BROWSER-2 in [docs/GAP-ANALYSIS.md](GAP-ANALYSIS.md), not something this wave fixed.

## 4. How it is driven

```
 Titan's turn
   browser_open / browser_click / browser_type / browser_screenshot
       |                         source/host/runner/tools
       v
   the driver, running inside the box
       |                         /opt/titanbot-runtime/browser-driver
       v
   Chrome, already up, on the person's profile, on the agent's own display
       |                         --remote-debugging-port on loopback, set by /usr/local/bin/box-chrome
       v
   the page
```

**Chrome is not restarted and not replaced.** The box's own launcher, `box-chrome`, already starts
it with `--remote-debugging-port` bound to loopback and `--user-data-dir` pointing at the profile
for that display. The driver attaches over that port. This is the point the gate measures hardest,
because getting it wrong has a specific, awful shape that this codebase has already lived through
once: a second Chrome comes up on a different profile with no debug port, and the operator watches
one browser while Titan drives another. The gate counts the running profiles and the windows on
every display, before and after, and fails if either grew.

**Nothing is installed in the box, and nothing is imported that the mount does not carry.** The
driver is seven plain `.mjs` files with no dependencies at all, shipped as source. It speaks the
Chrome DevTools Protocol over a WebSocket it implements itself, because the box's node 20 keeps the
global `WebSocket` behind a flag and there is no npm inside a box to install one. A test walks every
file in the directory and fails if any of them imports anything but a sibling or a `node:` builtin,
so the ship cannot silently start needing something the box does not have.

**The screenshot** is one JPEG, resized to 1280 wide, and it reaches the model as exactly one image
part beside the text. Not two, not zero. There is history here: the browser tools used to return
text only, then returned an image the history flattener silently dropped before the request left
(SUB-2 and SUB-2b in the gap analysis). The gate reads the image out of the request the model
actually received, decodes the JPEG's start-of-frame marker, and checks the width.

**The text** is the page's readable main body, not everything on it. Navigation, scripts and
stylesheets are dropped; if the readable pass finds almost nothing (an app shell, a page drawn into
a canvas) it falls back to the whole page's `innerText`, because some words beat none. It is capped
at 40,000 characters, and a page that hit the cap says so rather than stopping mid-sentence.

**Every open writes one row to the audit ledger**, `agents/<id>/audit.jsonl`, with the address and
the title. That is the receipt: what Titan looked at, in order, readable without asking him.

### The switch

`SAND_BROWSER_TOOLS`, in `/home/box/sand-data/sand-host-settings.json`, **defaults on**. It is read
live on every turn, so it moves on a running box with no restart and no recreate:

```sh
docker exec grok-bot-local-vm node -e 'const f=require("fs"),p="/home/box/sand-data/sand-host-settings.json";const d=JSON.parse(f.readFileSync(p,"utf8"));d.SAND_BROWSER_TOOLS="0";f.writeFileSync(p,JSON.stringify(d),{mode:0o600})'
```

With it off the four tools are withheld and the `[sand][toolset]` trace line says why, rather than
leaving them merely absent. Delete the key to go back to the default.

This is a different switch from `SAND_BROWSER_USE`, which is the older one and gates the *browserUse
subagent* and its fifteen tools. The two are independent: Titan's four can be on while the subagent
is off, which is the shipping default.

### Where the browser may go

The public web, and nothing else.

The address in a `browser_open` comes from the model, and the model is told things by the pages it
just read, by peers, and by text a person pasted. Without a check, "open file:///etc/passwd" reads
the box's own files and "open http://127.0.0.1:9232" reads the services sitting beside it, and both
come back to the provider as page text plus a picture. Measured on `grok-bot-local-vm` 2026-09-07,
before the check existed, both worked, and so did the operator console on
`host.docker.internal:7777`.

So two refusals, in plain words, on the same rule:

- **In the host**, before the box is touched at all. Only `http` and `https`. No loopback, no
  link-local, no private network, no `.internal` or `.localhost` name, no `host.docker.internal`.
- **In the box driver**, next to Chrome, which also resolves the name first. A name is free to
  point at `127.0.0.1`, and the host's check cannot see that.

The model is told *"I can only open pages on the public web."* and nothing else.

`SAND_BROWSER_ALLOW_HOSTS` is the way past it, and it is the operator's alone: a comma separated
list of host names, in the same settings file, read live. It never comes from the model's
arguments, and it is written into the request after them, so an `allowHosts` the model made up is
overwritten rather than added to. An operator who wants their own internal wiki read names it here:

```sh
docker exec grok-bot-local-vm node -e 'const f=require("fs"),p="/home/box/sand-data/sand-host-settings.json";const d=JSON.parse(f.readFileSync(p,"utf8"));d.SAND_BROWSER_ALLOW_HOSTS="wiki.example.internal";f.writeFileSync(p,JSON.stringify(d),{mode:0o600})'
```

## 5. The files

| Where | What |
|---|---|
| `runtime/browser-driver/` | The driver. Ships in the runtime mount, read-only in every box, at `/opt/titanbot-runtime/browser-driver`. |
| `runtime/browser-driver/host-op.mjs` | The box end of one tool call: it takes the request the host sends, drives the driver, and prints the one result line the host reads back. |
| `runtime/browser-driver/cli.mjs` | The same driver from a command line, for an operator checking a box by hand. |
| `source/host/runner/tools/sand-browser-direct-tools.ts` | Titan's four tools: their names, their arguments, and the descriptions that tell the model when to reach for them. |
| `runtime/browser-driver/page-text.mjs` | The judgements that need no browser: readable text, the cap, the login-wall test, the blocked test. Pure functions over an HTML string, unit-tested on a Mac with no box. |
| `source/host/runner/tools/sand-browser-tools.ts` | The shared machinery under both sets of tools: the shell call into the box, the auto-review preflight, the screenshot pulled back, the audit row. |
| `source/host/runner/tools/turn-toolset.ts` | The one predicate that decides whether Titan is offered them. |
| `source/host/runner/bot-block-detection.ts` | The 21-signature table for challenge pages. Unchanged by this wave, and still the authority. |
| `source/host/sand-box-setting.ts` | `SAND_BROWSER_TOOLS` and `SAND_BROWSER_ALLOW_HOSTS`, resolved live. |
| `deploy/r750/sync.sh` | Ships `runtime/browser-driver/` as a directory. |
| `scripts/build-host.mjs --deploy` | The same thing for the local Mac box. |
| `scripts/verify-browser-tools.mjs` | The gate. |
| `tests/browser-driver-extraction.test.mjs` | The unit tests for reading a page: the article, the cap, the innerText fallback, the login wall, the challenge page. |
| `tests/browser-tools.test.mjs` | The unit tests for the seam: what the driver catches that the host-side classifier cannot, and the shape of a tool result. |
| `tests/browser-direct-tools.test.mjs` | The unit tests for the four tools: one image, one audit row, plain words for a wall, and an address off the public web refused before the box is touched. |
| `tests/browser-driver-address-guard.test.mjs` | The unit tests for the second refusal, the one next to Chrome, including a name that resolves to loopback. |

### Two detectors, on purpose

`needsLogin` and `blocked` are each decided in two places and that is deliberate, not duplication
nobody noticed.

`bot-block-detection.ts` has been in this repo the whole time. It carries 21 signatures
(Cloudflare, reCAPTCHA, DataDome, PerimeterX, Imperva, AWS WAF and the rest) and it drives the
audit stream. It sees a url and a title and nothing else.

The driver sees things that classifier never will: the HTTP status, the number of password fields
on the page, the body itself. So it makes its own fast judgement from those, and the tool layer
takes either. A 403 from a vendor's own server with a perfectly ordinary title is invisible to the
signature table and obvious to the driver; "Just a moment..." is the reverse. Deleting either one
because the other exists would lose half the cases, which is why `tests/browser-tools.test.mjs`
pins both together in one test.

The false positive that would actually hurt is a newsletter sign-up box at the foot of a long
article reading as a login wall, because then every page Titan reads hands the person a sign-in
they do not need. The wall test requires a password field, or a sign-in path with nothing else on
the page. A long article with a sign-up box has neither. There is a test for exactly that.

## 6. Measuring it

```sh
node --test tests/browser-tools.test.mjs

node scripts/verify-browser-tools.mjs --dry-run

SAND_PROFILE_DIRS=/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data \
  node scripts/verify-browser-tools.mjs
```

The unit tests need nothing: no box, no docker, no network. They cover the judgements and the shape
of a tool result.

`--dry-run` needs nothing either, and it is the answer to a question a gate cannot usually answer
about itself: does the gate work? It stands up the same two servers, plays the host, drives the
stub through the whole plan with tool results it composes, and checks what came back: the steps
dispatch in order with the right addresses, the result reader pairs each image with the page it
belongs to, the JPEG reader takes the width and not the height, and the three fixtures really do
serve the prose, the password field and the 403 that the live run's assertions look for. A plan
that dispatches out of order or a reader that pairs an image with the wrong page would make the
live run *lie* rather than fail, which is why this exists. 29 checks, about a second.

**The gate needs the box, and it must run on its own.** It repins the box's model endpoint for the
length of the run, so a second gate running beside it would be answered by this one's stub.

It does not use a real model. A stub OpenAI-compatible server on the Mac answers with a scripted
sequence of tool calls, so the same eight actions run in the same order every time and a failure is
the product's rather than the model's mood. The stub is also the measurement surface: the host
hands every tool result back in the next request, so the stub reads the exact text and the exact
image parts the model was given. Nothing else in this repo can see that.

It serves its own fixtures on `host.docker.internal` (a form page, a login wall, a 403 with a body
and a 403 with none) so the click, the typing, the login hand-off and the blocked flag are measured
against pages the gate controls rather than whatever the open web did that morning. Those fixtures
are on a private address, so the run names `host.docker.internal` in `SAND_BROWSER_ALLOW_HOSTS`
for its length and puts the setting back after.

Twelve things it asserts:

1. The four tools are in the **chief's** own toolset line, not a subagent's.
2. They leave for the provider: the `[sand][wire]` line carries them, `sent == offered`.
3. The system prompt says when to use them, when to delegate, and how to hand a login back.
4. `https://example.com` comes back as its own words; the YouTube channel comes back with its title.
5. A login-walled page reports needing a login, in plain words, not a flag name.
6. A page that refuses us is reported as blocked. Both the refusal that serves a body, and the bare
   one that serves none, which is what a real site sends and which Chrome fails outright.
7. Typing and clicking change the gate's own page the way that page says they should.
8. Every result is text plus exactly **one** image part, a JPEG 1280 wide.
9. The audit ledger gained one `browser_navigation` row per open, with the address and the title.
10. The desktop view still shows the same Chrome: no new profile, no display's window count doubled.
11. With `SAND_BROWSER_TOOLS` off, the four are withheld and the trace line says why.
12. An address that is not on the public web is refused in plain words, with no picture and no
    ledger row: a local file, and the box's own loopback. No line of the box's password file and no
    part of the operator console reaches the model.

Flags: `--dry-run` is the no-box run above, `--offline` skips the two public pages, `--no-off-leg`
skips 11, `--keep` leaves the scratch agent behind. Exit 0 nothing failed, 1 something failed,
2 nothing could be measured.

It creates its own scratch agent and deletes it, and it puts the endpoint pin, `SAND_TOOL_TRACE`,
`SAND_BROWSER_TOOLS` and `SAND_BROWSER_ALLOW_HOSTS` back the way it found them whatever happened.

### What is measured, and what is not

Kept apart on purpose. A number with no machine behind it is a plan.

**Measured, on `grok-bot-local-vm` (this Mac), 2026-09-08.**

| What | Result |
|---|---|
| `node scripts/verify-browser-tools.mjs` **against the box** | **106 PASS, 0 FAIL, 0 SKIP.** All twelve groups above, on a real turn with a real Chrome |
| `https://example.com` | Opened, title "Example Domain", its own body text back, one JPEG 1280x656, 14,764 bytes |
| `https://www.youtube.com/@TitaniumComputing` | Opened, title "Titanium Computing - YouTube", channel text back, one JPEG 1280x656, 70,103 bytes |
| the login wall | `needsLogin`, reported in plain words with no flag name and no tool name in the sentence |
| the 403 page with a body | `blocked`, reported in plain words |
| the 403 page with no body | `blocked` as well, one JPEG 1280x656 of Chrome's own refusal page, and no `net::` code anywhere in the words the model reads |
| typing and clicking | `browser_type` into `input#note` then `browser_click` on "Save note"; the page's own text changed to say both landed |
| `file:///etc/passwd` and `http://127.0.0.1:7777/` | refused with "I can only open pages on the public web", no picture, no ledger row, and the box never asked |
| the toolset | chief offered 34 tools, 4 of them `browser_*`, `isSubagentRunner=false`; the request that left carried all 34 |
| images | 9 results with a picture, 9 image parts in the turn history and 9 in the request that left, every one `image/jpeg` 1280 wide |
| the audit ledger | 6 opens, 6 `browser_navigation` rows, every row with the address that was asked for and its title |
| the desktop view | no second Chrome, no display's window count doubled |
| the switch off | the four withheld, and the toolset line says `browser_tools_off` |
| `node scripts/verify-browser-tools.mjs --dry-run` | 36 of 36 PASS, no box, no gateway token, under a second |
| `node --test tests/*.test.mjs` | 1210 tests, 1210 PASS, 0 FAIL |

**How long it takes.** About six minutes against a box, because eight of those steps are real page
loads in a real browser. It does not fit a 290-second budget: run it detached and read its log.

Landing the unit tests turned up something that had nothing to do with the browser and mattered
more: `tests/index.js`, which is what `node --test tests/` loads, listed 79 of the 101 suites, so
the command the runbook gives an operator ran 891 tests where the glob ran 1101. `browser-tools`
would have been the 23rd file it silently skipped. The list is complete now and
`tests/test-index-covers-the-suite.test.mjs` fails the suite if it drifts again. TESTS-1 in
[docs/GAP-ANALYSIS.md](GAP-ANALYSIS.md) has the whole measurement and the two residuals.

**Not measured.** Two things, named so nobody reads the table above as covering them.

The R750 has had the ship but not this gate: the gate needs a stub model on the machine running it,
so what was measured there is one real turn on the demo box, written into the BROWSER-1 row in
[docs/GAP-ANALYSIS.md](GAP-ANALYSIS.md), not these 86 checks.

And the login hand-off in section 3 has never been done end to end by a person: the gate proves the
page is *reported* as needing a sign-in, not that signing in through the desktop view and asking
Titan to carry on works. BROWSER-2 already says the login would not survive a recreate on Titan's
own seat, which is the harder half of the same problem.
