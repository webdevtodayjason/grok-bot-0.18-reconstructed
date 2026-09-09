# Marketing on Titanium Bot

What a marketing agency actually gets, what it has to provide, and the things that bite.

Everything below is about ONE workspace running MANY clients. That is the shape: about seven
shared specialists, and a brand profile per client as configuration. Twenty clients are twenty
documents, not twenty teams. A dedicated team is what you build only where the guardrails
themselves differ, and that is rare.

---

## 1. The first hour

1. Open **Marketplace**, then the **Bots** tab, then the **Marketing** chip.
2. Open **Marketing team**. Read **The team** (who the seven are) and **What you provide** before
   you press anything. The second page is short on purpose and two of its lines take days.
3. Press **Import team**. It asks once, naming every plugin it will NOT install and every key it
   will NOT write, and a second press goes ahead. It creates seven bots and imports ten documents.
   It installs nothing and stores no key: those are yours to add deliberately, on each plugin's own
   card.
4. Message **Marketing · Brand profile keeper** with a client. It reads their site and their last
   month of posts, then asks you about the three things that are never public: what they must never
   say, who approves, and which accounts exist.
5. Message **Marketing · Coordinator** with that client and a week. You get a plan, then drafts,
   then ONE decision card listing the whole batch. Nothing leaves the box until you answer it.

**Remove team** on the pack's page takes back both the bots and the documents. Deleting a bot from
the roster does not: skills live in the box's shared library and outlive the bot that imported
them, which is why the pack has its own removal.

---

## 2. The seven, and what each is for

| Bot | What it does | What it will not do |
| --- | --- | --- |
| **Coordinator** | Runs one client's week end to end. Loads the profile itself, asks the specialists, assembles the batch, raises the single card. Reports to Titan. | Write copy or read analytics. It decides and it asks. |
| **Social strategist** | Turns the profile plus what is happening into a dated plan with a reason per slot, and marks slots blocked when the photo does not exist yet. | Write the copy. |
| **Copywriter** | Writes the posts in the client's own register, per network, with alt text and a note saying what each image should show. | Soften a banned claim into a permitted one. It pulls it out instead. |
| **Community manager** | Sorts comments and messages into question, complaint, praise, spam, and anything naming a live job, then drafts what needs a reply. | Quote a price, name a competitor, or admit or deny a fault in public. Ever. |
| **Paid ads planner** | Plans a flight against a real budget: offer, audience, split, creative, the numbers to watch and the rule that stops it. | Buy anything, or invent a reach projection. Those are the platform's numbers. |
| **Analytics reporter** | Reports the window with every number beside the post that earned it, and names the account it could not reach. | Call a two percent move a trend. |
| **Brand profile keeper** | Owns one profile per client and keeps them current. | Edit the template or the worked example into a client profile. Those two stay copyable. |

---

## 3. The brand profile

One document per client, in the box's shared library, loaded by every specialist before it does
anything. It is a SKILL.md because that is the document shape this box already has a home for: it
imports, every bot can read it, and you edit it in the console with no second editor to learn.

Headings, all required:

- **Who they are** — one paragraph an outsider would recognise them from.
- **Voice** — three adjectives, then two real sentences of theirs. The quotes are what a copywriter
  can match; the adjectives are not.
- **Audiences** — two or three, each with the thing it actually wants. Jobs to be done, not
  demographics.
- **Offers** — what is for sale now, with the price if it is public.
- **Do not say** — the hard list, and the part that earns its keep. Push for it: what a previous
  agency got wrong, what legal objected to, what the owner hates seeing. "Nothing" is a question
  you have not asked twice.
- **Approval rules** — who says yes, to what, and what may never go out even with a yes.
- **Accounts** — every account, by network and handle, with who holds the login, and the ones that
  are not connected marked as such.

The pack ships two: `mkt-brand-profile-template` (blank, copy it per client) and
`mkt-brand-northgate` (a worked example for a plumbing firm, which is also what the gate drives).
A heading left blank is not a gap, it is a licence for a specialist to invent something, so write
"none yet" instead.

---

## 4. Approvals

Nothing reaches the public until you answer a decision card. The card is
`SendMessage {"type":"widget"}`, which **ends the bot's turn** — that is the mechanism, not the
etiquette. A model that would otherwise keep going cannot skip it, because there is no turn left
to keep going in.

The granularity matters more than the rule:

- The coordinator presents the week as **ONE card** listing every post. A card that arrives with a
  single post on it teaches you to say yes without reading.
- Your yes covers **exactly the listed batch**. Anything edited afterwards, anything added, and
  anything moved to a different window needs a fresh card.
- Anything touching the client's do-not-say list is **broken out for its own yes**, never folded in
  among safe items where one yes would cover it.
- Where posting costs money, the **count and the total are in the prompt, before the yes**. X
  charges per post created. Until you set a spending limit for the workspace, the team drafts and
  stops rather than offering to post at all.

The rule is written into all seven personas AND shipped as a skill (`mkt-approval-rule`), because
a persona is advice and a skill is a procedure with steps.

---

## 5. The engines: how a bot actually reaches a network

There is no connector that publishes an ordinary post anywhere. That is not a gap in this product,
it is what the vendors ship:

- **Meta's** own servers manage apps and webhooks, and separately manage ads. Neither posts.
- **X's** hosted server reads posts and writes bookmarks and Articles. It does not post.
- **LinkedIn** has none.

So organic posting is one of two things, and the team is built for both:

**The browser.** A bot drives a real Chrome signed in as the client. This is the honest path for
any network whose API needs an app review a small business will not pass. When a page needs a
person (a code, a captcha, an identity check) the bot hands it to you with a live view and picks up
after you hand it back.

**The client's own developer app.** Their tokens, their app, their review. The Marketplace rows for
Meta, X and LinkedIn say "bring your own app" because that is the truth, and the first-run page
names the two prerequisites that strand people:

- **A LinkedIn Page has to exist before a LinkedIn developer app can.** You cannot make the app
  first and attach a Page later.
- **A Meta Business has to exist in Business Manager before Business Verification can start**, and
  verification is what an agency posting for a client's Page needs. Standard Access lets you post
  to your OWN Page with no review; the moment you post for a client whose staff hold no role on
  your app, you are in Advanced Access, App Review, Business Verification and an annual Data Use
  Checkup.

---

## 6. What bites

**No official connector publishes an organic post anywhere.** Said again because it is the single
thing people assume. Adding the Meta connector does not give you posting.

**A scheduler's key reaches every client in the account.** Buffer's API key is account-wide with no
per-organization scoping. One key, every client's channels. Decide whether that is acceptable
before you paste it, not after.

**X costs money per post.** There are no tiers any more: pay-per-usage, and a post with a URL costs
more than one without. The approval card carries the count and the total, and posting stays off
until a per-tenant ceiling is set.

**LinkedIn tokens expire every 60 days and there is no programmatic refresh** unless you are a
named partner. Somebody re-authorises every two months, forever. Put it in a calendar.

**LinkedIn publishes no rate limits, by policy.** Not "we could not find them" — they say they do
not publish them. Plan for the limit you cannot see.

**Browser Use profiles are minted by hand.** Saved logins per workspace are created in the vendor's
own dashboard; there is no documented endpoint to create one. The docs here say so rather than
promising an API that does not exist.

**Skills are shared and they outlive their bot.** Everything imported goes into the box's shared
library, which every bot on the box can see, and deleting a bot leaves its documents behind. The
pack namespaces every document it ships (`mkt-`) and its Remove team takes both back. This is also
why a second Import team leaves no duplicates where importing an ordinary template twice does.

**The team will refuse rather than half-arrive.** It reads the workspace's bot limit before it
creates anything. If seven will not fit you get one sentence saying how many there is room for and
how many to free up, and nothing is created — because a half-imported team cannot be undone from
the roster.

---

## 7. Where the code is

| Thing | File |
| --- | --- |
| The pack: members, personas, skills, brand profiles, first-run | `source/shared/marketplace/marketing-team.ts` |
| The Bots tab, the pack page, Import team, Remove team | `ui/machine-room/marketplace-bots.js` |
| The row's invariants as a unit test | `tests/marketing-pack.test.mjs` |
| The gate, in a real browser against a real box | `scripts/verify-marketing.mjs` |
| The Marketplace rows for the marketing vendors | `docs/CONNECTORS.md` |

Roadmap, deliberately not built in this release: roster grouping and sub-coordinators (TEAMS-1),
a per-tenant OAuth callback for Meta, X and LinkedIn, and a Canva row.
