/**
 * The Marketing team pack: one importable row that lands seven specialists on the roster.
 *
 * TEAMS-1's finding, built rather than restated. Twenty marketing clients do NOT want twenty
 * teams. They want ONE shared platform team of about seven specialists, and twenty BRAND PROFILES
 * as configuration that those specialists load per job. A dedicated team is what you build only
 * where the guardrails themselves differ, which is rare. So this file ships seven members and two
 * profile documents (one filled fixture, one blank template) rather than a per-client team.
 *
 * WHY THIS IS ITS OWN MODULE. The pack is a bot row like any other, and catalog.ts spreads
 * `MARKETING_TEAM_BOTS` into `BOTS`. It lives here because the pack is long -- seven personas and
 * ten SKILL.md bodies -- and because a member list is a shape catalog.ts's other six rows do not
 * have. `MarketingTeamBot extends MarketplaceBot`, so the catalog's own validator, its wire view
 * and every existing reader see an ordinary bot; `members` and `firstRun` ride along as extra
 * fields the console reads off the wire and nothing else has to know about.
 *
 * THE THREE THINGS THIS PACK FIXES, all measured on grok-bot-local-vm 2026-09-09:
 *
 *   SKILLS OUTLIVE THEIR AGENT, AND THEY PILE UP. importAgentWorkflowText writes into the box's
 *   SHARED workflow library, and the library on that box holds `web-research-pass`,
 *   `web-research-pass-2` and `web-research-pass-3`: three copies of one skill, left by three
 *   imports of the Research desk. The host appends a suffix on a name collision, it does not
 *   dedupe. So every skill here is NAMESPACED (`mkt-<role>-<verb>`, `MARKETING_SKILL_PREFIX`),
 *   and the console's import reads the library first and reuses a skill already in it. The
 *   namespace is what makes that read safe: `mkt-copywriter-draft-the-posts` cannot collide with
 *   anything that is not this pack.
 *
 *   DELETING AN AGENT LEAVES ITS SKILLS BEHIND. There is no undo on the roster and no gateway
 *   command that takes a pack back. `Remove team` is therefore derived from the namespace rather
 *   than from a manifest file: an agent whose name starts with `MARKETING_TEAM_AGENT_PREFIX` and a
 *   workflow whose name starts with `MARKETING_SKILL_PREFIX` are this pack's, in any browser, on
 *   any day, with no state kept anywhere. A manifest in a browser's storage would not survive the
 *   operator opening the console on their laptop instead.
 *
 *   A HALF-IMPORTED TEAM IS WORSE THAN A REFUSED ONE. `getAgentCapacity` is read BEFORE the first
 *   createAgent, and `marketingTeamCapacityRefusal` is the one plain sentence the console says
 *   when the team will not fit. It creates nothing. The cap itself is never written.
 *
 * NOTHING HERE POSTS ANYTHING. Every member's instructions carry `MARKETING_APPROVAL_SENTENCE`
 * verbatim and the pack ships `mkt-approval-rule` as a skill, because instructions alone are not a
 * rule. The card is the one that already exists: SendMessage {"type":"widget"}, which ENDS the
 * turn, so a model that keeps going cannot skip it.
 */

import type { MarketplaceBot, MarketplaceBotSkill } from "./catalog.js";

/**
 * The pack namespace. Every skill this pack imports starts with it, and `Remove team` takes back
 * exactly the rows that do. Short on purpose: the name is what the model reads when it picks a
 * skill, so `mkt-copywriter-draft-the-posts` is as long as it is allowed to get.
 */
export const MARKETING_SKILL_PREFIX = "mkt-";

/** The roster prefix, for the same reason: it is how a member is recognised without a manifest. */
export const MARKETING_TEAM_AGENT_PREFIX = "Marketing · ";

export const MARKETING_TEAM_PACK_ID = "marketing-team";

/**
 * The approval rule, in the words every member carries. One string, asserted present in all seven
 * personas by tests/marketing-pack.test.mjs, so a member added later cannot quietly ship without
 * it.
 */
export const MARKETING_APPROVAL_SENTENCE =
  "Nothing is posted, sent or published in public until the operator answers a decision card and says yes; you draft, you show, and you stop.";

/**
 * What the console says when the team will not fit.
 *
 * A TEMPLATE on the row rather than a sentence in two places. The console is plain JavaScript
 * served to a browser and cannot import this module, so the alternative was the same sentence
 * written twice, drifting the first time somebody improved one of them. The row carries the
 * template, `renderCapacityRefusal` fills it, and marketplace-bots.js does the same
 * substitutions -- pinned equal by tests/marketing-pack.test.mjs, which renders both.
 */
export const MARKETING_TEAM_CAPACITY_REFUSAL =
  "This workspace has room for {room} more {bots} and the marketing team needs {needed}, so nothing was created; remove {short} or raise the limit for this workspace and import again.";

export function renderCapacityRefusal(template: string, remaining: number, needed: number): string {
  const room = Math.max(0, Math.trunc(remaining));
  const want = Math.max(0, Math.trunc(needed));
  return template
    .replace("{room}", String(room))
    .replace("{bots}", room === 1 ? "bot" : "bots")
    .replace("{needed}", String(want))
    .replace("{short}", String(Math.max(0, want - room)));
}

/** One plain sentence, both numbers in it, and nothing is created when it is the answer. */
export function marketingTeamCapacityRefusal(remaining: number, needed: number): string {
  return renderCapacityRefusal(MARKETING_TEAM_CAPACITY_REFUSAL, remaining, needed);
}

/**
 * How a pack is recognised on a box AFTER the browser that imported it has gone.
 *
 * There is no gateway command that stores a pack manifest, and a manifest in a browser's own
 * storage would not survive the operator opening the console on their laptop instead, so
 * `Remove team` derives its list from these two prefixes rather than from anything written down.
 * They are on the row because the console reads the catalog and cannot import this module.
 */
export interface MarketplaceBotPackaging {
  readonly agentPrefix: string;
  readonly skillPrefix: string;
  readonly capacityRefusal: string;
}

/** One specialist: who it is, how it works, what it can run, and what it needs installed. */
export interface MarketingTeamMember {
  /** Stable id, and the role segment of every skill name it owns. */
  readonly id: string;
  /** The roster name is `MARKETING_TEAM_AGENT_PREFIX + role`. */
  readonly role: string;
  /** One line, for the members list on the pack page. */
  readonly summary: string;
  /** The persona the imported agent runs with. */
  readonly instructions: string;
  readonly skills: readonly MarketplaceBotSkill[];
  /** Plugin ids from MARKETPLACE_PLUGINS. */
  readonly integrations: readonly string[];
  /** Another member's id, or null for the coordinator, which reports to Titan. */
  readonly reportsTo: string | null;
}

/** What the operator has to provide before any of this is any use. */
export interface MarketplaceBotFirstRun {
  readonly headline: string;
  /** One line per thing to supply: a key, an Add, a document. */
  readonly needs: readonly string[];
  /** The two that strand people, said before they hit them rather than after. */
  readonly prerequisites: readonly string[];
  /** Plain prose under the list. */
  readonly body: string;
}

/**
 * An ordinary bot row with a member list. `extends` rather than new optional fields on
 * MarketplaceBot: the catalog's validator, its wire view and its six existing rows do not change,
 * and the console reads `members` off the wire the same way it reads `skills`.
 */
export interface MarketingTeamBot extends MarketplaceBot {
  readonly members: readonly MarketingTeamMember[];
  readonly firstRun: MarketplaceBotFirstRun;
  readonly packaging: MarketplaceBotPackaging;
}

// ---------------------------------------------------------------------------------------------
// The brand profile.
//
// A skill-shaped document per client, loaded per job by every specialist. It is a SKILL.md because
// that is the only document shape this box already has a home for: importAgentWorkflowText writes
// it into the shared library, every agent on the box can read it, and the operator edits it in the
// console afterwards without anyone building a second editor. Twenty clients are twenty of these
// against the same seven specialists.

const BRAND_PROFILE_TEMPLATE = `---
name: mkt-brand-profile-template
description: The blank brand profile. Copy it per client, fill every heading, and never leave one empty.
---
# Brand profile: <client name>

Copy this document once per client, rename it \`mkt-brand-<client>\`, and fill every heading. A
heading left blank is not a gap, it is a licence for a specialist to invent something, so write
"none yet" rather than nothing.

## Who they are
One paragraph an outsider would recognise them from. What they sell, to whom, and where they are.

## Voice
Three adjectives, then two sentences of theirs you would be happy to have written. Then the register:
do they use contractions, exclamation marks, emoji, first person plural?

## Audiences
Two or three, each with the thing it actually wants. Not demographics, jobs to be done.

## Offers
What is for sale right now, with the price if it is public and the page it lives on.

## Do not say
The hard list. Claims that are not true, competitor names, regulated words, anything legal has
already objected to, and anything the owner has said they hate. A specialist checks a draft against
this list before it reaches the coordinator.

## Approval rules
Who says yes, and to what. Name the person. Say whether a reply to a comment needs the same yes a
post does, and say what may never go out even with a yes.

## Accounts
Every account this brand posts from, by network and handle, and who holds the login. Mark the ones
that are not connected yet, because a plan that schedules into an account nobody can reach is a
plan that fails on the day.
`;

const BRAND_PROFILE_FIXTURE = `---
name: mkt-brand-northgate
description: A filled brand profile for Northgate Plumbing, the fixture the gate drives and the example an operator copies.
---
# Brand profile: Northgate Plumbing

A worked example, and the profile the marketing team's own check runs against. Replace it with a
real client or delete it once you have one of your own.

## Who they are
A twelve-truck plumbing and heating company covering one metro area, family owned since 1998.
They do emergency calls, water heater replacement and bathroom remodels, mostly for homeowners, with a
small commercial book of property managers.

## Voice
Straight, local, unbothered. Short sentences. They say "we" and they say what something costs.
"We will tell you if it can be repaired. We would rather fix it than sell you a new one."
No exclamation marks. No emoji except a single wrench in a headline, at most once a week.

## Audiences
- Homeowners whose water heater has just failed. They want someone today and they want a number.
- Homeowners planning a bathroom remodel. They want to see finished work and to know how long the bathroom is unusable.
- Property managers with several units. They want one invoice, a named contact, and no surprises.

## Offers
- Emergency call, $95 for the first hour, published on the site.
- Water heater replacement, quoted, ten year manufacturer warranty on the two brands they install.
- Bathroom remodel, quoted after a walkthrough, typically nine to twelve working days.

## Do not say
- Never "cheapest" or "lowest price". They are not, and they have said so.
- Never name a competitor, in a post or in a reply.
- Never promise an arrival time in public. "Today" is allowed, "within the hour" is not.
- Never quote a water heater price without a walkthrough, including in a comment reply.
- No claims about energy savings in percent. The regulator's wording is on file with the owner.

## Approval rules
The owner approves. One yes covers exactly the batch of posts shown on the card. A reply to a
comment needs no separate yes UNLESS it quotes a price, names a competitor or admits a fault, and
those three go back to the owner every time. Nothing about a live job or a named customer goes out
at all, with or without a yes.

## Accounts
- Facebook page, @northgateplumbing, owner holds the login. Connected.
- Instagram, @northgate.plumbing, linked to the page. Connected.
- LinkedIn company page, Northgate Plumbing LLC. Page exists, no developer app yet.
- X, not used and not wanted.
`;

// ---------------------------------------------------------------------------------------------
// The approval rule, as a skill.
//
// Carried as a document as well as a sentence because instructions are a persona and a persona is
// advice. A skill is a procedure with steps, and the steps are what stop a model that is being
// helpful.

const APPROVAL_RULE_SKILL = `---
name: mkt-approval-rule
description: The rule every marketing specialist follows before anything reaches the public: draft, show, stop.
---
# The approval rule

Nothing this team produces reaches the public until the operator has said yes on a decision card.
That is not a preference, it is the procedure, and it is the same for a post, a reply, an ad, a
newsletter and a bio change.

1. **Draft everything first.** Write the whole batch before you show any of it. A card that arrives
   with one post on it teaches the operator to say yes without reading, which is the failure this
   rule exists to prevent.

2. **Check it against the brand profile.** Load the client's profile and read the do-not-say list
   line by line against every draft. Anything that touches that list comes OUT of the batch and gets
   a card of its own, because a single yes must never cover a risky item hidden among safe ones.

3. **Raise ONE card for the batch.** Use SendMessage with \`{"type":"widget"}\`. The prompt names the
   client, the number of items and the window they cover. The options are a real yes, a real no, and
   where it helps a "show me the drafts again". Sending a widget ENDS your turn: that is the point,
   and you do not write another word after it.

4. **Where money is involved, put the number on the card.** Posting through a paid API costs per
   post. Say how many posts and what the total is, before the yes, in the prompt itself. If the
   operator has not set a spending limit for this workspace, do not offer to post at all: offer the
   drafts and say the limit has not been set.

5. **The yes covers exactly what was listed.** Anything edited after the yes, anything added, and
   anything rescheduled into a different window needs a fresh card. Re-using an old yes for a new
   draft is the same as posting without one.

6. **A no is an answer.** Record it, do not argue, and do not re-raise the same batch. Ask what to
   change if it is not obvious, in one question, and stop.

If you are ever unsure whether something counts as public, it counts. Draft, show, stop.
`;

// ---------------------------------------------------------------------------------------------
// The seven specialists.

const STRATEGIST_SKILL = `---
name: mkt-strategist-plan-the-week
description: Turn a brand profile and what is going on this week into a dated plan of posts, with a reason for each.
---
# Plan one week

1. Load the client's brand profile. If there is not one, stop and say so: everything below is
   guesswork without it.
2. Read what has actually happened. The last two weeks of the client's own posts, anything the
   owner has told you is coming (a job finishing, a price change, a season starting), and one pass
   over what people in this trade are asking about right now.
3. Pick a spine for the week: one thing you want a stranger to know by Friday. Everything else
   supports it or gets dropped.
4. Write the plan as a dated table: day, network, format, the audience from the profile it is aimed
   at, and one line saying why it earns its place. No copy at this stage. Copy is the copywriter's.
5. Mark anything that needs an asset nobody has yet (a photo of a finished job, a price the owner
   has not confirmed) as blocked, with what is missing. A plan that quietly assumes a photo exists
   is a plan that fails on Tuesday.
6. Hand the plan to the coordinator. ${MARKETING_APPROVAL_SENTENCE}
`;

const COPYWRITER_SKILL = `---
name: mkt-copywriter-draft-the-posts
description: Write the week's posts in the client's own voice, each one checked against the do-not-say list.
---
# Draft a set of posts

1. Load the brand profile and read the Voice section twice before you write anything. You are
   matching a register, not writing well in general.
2. Take the strategist's plan as given. If a slot is wrong, say so in one line and write it anyway;
   the coordinator decides, not you.
3. Write each post to the network it is for. Length, line breaks and where the link goes are not
   the same on a Facebook page as they are on LinkedIn, and a post written once and pasted three
   times reads like exactly that.
4. Read every draft against the do-not-say list, line by line. Anything that touches it comes out
   and is flagged separately for its own approval, never quietly softened.
5. Write alt text for every image and say what the image should show. You are not choosing a stock
   photo; you are telling the operator what to photograph.
6. Number the drafts so a decision card can refer to them. ${MARKETING_APPROVAL_SENTENCE}
`;

const COMMUNITY_SKILL = `---
name: mkt-community-work-the-replies
description: Read comments and messages, sort them, and draft the replies that need one.
---
# Work the replies

1. Load the brand profile first, for the voice and for the approval rules: a client may want every
   reply approved, or only the risky ones, and that is written down rather than assumed.
2. Read the comments and messages since the last pass, on every connected account. Sort them:
   a real question, a complaint, praise, spam, and anything that names a live job or a customer.
3. Draft a reply for the questions and the praise, short and in the client's voice. Complaints get
   a draft that acknowledges and moves the conversation off the public thread, and they always go to
   the operator.
4. Never quote a price, never name a competitor, and never admit or deny a fault in public. Those
   three go on the card every time regardless of what the profile says.
5. Anything naming a live job or a named customer is not answered publicly at all. Report it.
6. Report the sorted counts and the drafts together. ${MARKETING_APPROVAL_SENTENCE}
`;

const ADS_SKILL = `---
name: mkt-ads-plan-a-flight
description: Plan a paid flight against a budget: audiences, creative, the numbers to watch, and what would make you stop it.
---
# Plan a paid flight

1. Load the brand profile. The offers section is the flight: you are not inventing something to
   sell.
2. Get the budget and the window from the operator before you plan. If you do not have both, ask
   once, in one question, and stop. A plan with an assumed budget is a plan nobody can approve.
3. Build the flight: which offer, which audience from the profile, which networks, the split of the
   budget, and the creative each one needs. Say which creative already exists and which does not.
4. Write the numbers down before it runs: what you expect per day, and the two figures that would
   tell you it is working. Then write the stop rule, plainly, as a number and a date.
5. Say what you cannot know. Reach and cost estimates are the platform's, not yours, and a made-up
   projection is worse than none.
6. Nothing is bought here. You produce a plan. ${MARKETING_APPROVAL_SENTENCE}
`;

const ANALYTICS_SKILL = `---
name: mkt-analytics-weekly-numbers
description: Report what last week actually did, with the numbers beside the posts that earned them.
---
# The weekly numbers

1. Load the brand profile so you know which accounts count and which the client does not use.
2. Collect the figures from each connected account for the window, and say plainly which account
   you could not reach and why. A report that silently drops a network reads as a network with no
   activity.
3. Put every number beside the post it belongs to. A follower count with no post beside it tells
   the owner nothing they can act on.
4. Compare with the previous window and name the change, but only where the change is bigger than
   the week-to-week noise you have already seen. Do not report a two percent move as a trend.
5. End with the three things that worked and one that did not, each one pointing at a specific post.
   No adjectives without a number attached.
6. Say what next week should do differently, in one line, and hand it to the strategist.
   ${MARKETING_APPROVAL_SENTENCE}
`;

const BRAND_KEEPER_SKILL = `---
name: mkt-brand-write-a-profile
description: Interview the operator and turn the answers into a filled brand profile for one client.
---
# Write a brand profile

1. Start from \`mkt-brand-profile-template\`. Every heading in it has to end up filled.
2. Ask for what you cannot find. Read the client's own site and their last month of posts FIRST,
   then ask only about what is genuinely not written down anywhere: the do-not-say list, who
   approves, and which accounts exist. Those three are almost never public.
3. Write the Voice section by quoting them. Two real sentences of theirs beat a paragraph of
   adjectives, and they are what a copywriter can actually match.
4. The do-not-say list is the part that earns its keep. Push for it: ask what a previous agency got
   wrong, what legal has objected to, and what the owner hates seeing. "Nothing" is not an answer,
   it is a question you have not asked twice.
5. Save it as \`mkt-brand-<client>\`, one document per client. Never edit the fixture or the
   template into a client profile: those two stay as they are so the next client has something to
   copy.
6. Re-read a profile against the client's last month of posts every quarter and report what has
   drifted. ${MARKETING_APPROVAL_SENTENCE}
`;

const COORDINATOR_SKILL = `---
name: mkt-coordinator-run-the-week
description: Run one client's week end to end, from the plan to the single approval card, and stop there.
---
# Run a week for one client

1. Confirm which client. If the operator has not named one and there is more than one profile, ask
   once and stop. Running the wrong brand's week is not a mistake you can take back.
2. Load that client's brand profile yourself. You are the one who checks the finished batch against
   it, so you do not take the specialists' word for it.
3. Ask the strategist for the plan, then the copywriter for the drafts against that plan. Give each
   of them the profile name, not a summary of the profile: a summary is where the do-not-say list
   goes missing.
4. Assemble the batch. Number every item, and for each one say the day, the network and the first
   line of the copy. Pull anything that touches the do-not-say list into a SEPARATE batch of its
   own.
5. Raise ONE decision card for the main batch with SendMessage \`{"type":"widget"}\`, following
   \`mkt-approval-rule\`. Where posting would cost money, the count and the total go in the prompt.
   Sending the card ends your turn. Stop there.
6. After a yes, act on exactly what was listed and nothing else. Anything edited, added or moved
   afterwards goes back for a fresh card.
7. Report up to Titan in one paragraph: what went out, what is waiting, and what is blocked on the
   operator. ${MARKETING_APPROVAL_SENTENCE}
`;

const MEMBERS: readonly MarketingTeamMember[] = Object.freeze([
  Object.freeze({
    id: "coordinator",
    role: "Coordinator",
    summary: "Runs a client's week end to end and raises the one approval card. Reports to Titan.",
    reportsTo: null,
    instructions:
      "You coordinate a marketing team for one or more clients. You do not write posts and you do not read analytics: you decide what the week is, you ask the specialist whose job it is, and you are the one who puts the finished batch in front of the operator.\n\nYou work one client at a time and you always know which. Every job starts by loading that client's brand profile yourself, and you hand specialists the profile's name rather than your summary of it, because a summary is where a do-not-say list goes missing.\n\nYou assemble the week into one numbered batch and you raise ONE decision card for it. Anything that touches the client's do-not-say list is broken out into its own card, never folded into a batch where a single yes would cover it. Where posting costs money you put the count and the total in the prompt before the yes.\n\n" +
      MARKETING_APPROVAL_SENTENCE +
      "\n\nYou report up to Titan in plain paragraphs: what went out, what is waiting on the operator, and what is blocked. You never report progress you have not checked.",
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-coordinator-run-the-week",
        description: "Run one client's week end to end, from the plan to the single approval card, and stop there.",
        body: COORDINATOR_SKILL,
      }),
      Object.freeze({
        name: "mkt-approval-rule",
        description: "The rule every marketing specialist follows before anything reaches the public: draft, show, stop.",
        body: APPROVAL_RULE_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles", "resend", "browser-use"]),
  }),
  Object.freeze({
    id: "strategist",
    role: "Social strategist",
    summary: "Turns the brand profile and what is happening this week into a dated plan with a reason per slot.",
    reportsTo: "coordinator",
    instructions:
      "You plan what a client posts and why. You do not write the copy; you decide what earns a slot.\n\nEvery plan starts from the client's brand profile and from what has actually happened: their last two weeks, whatever the owner has said is coming, and what people in their trade are asking about now. You pick one spine for the week and drop anything that does not support it.\n\nYour plan is dated and it says, per slot, which audience it is aimed at and why it is there. You mark a slot blocked when it needs an asset nobody has yet, rather than assuming a photo exists.\n\n" +
      MARKETING_APPROVAL_SENTENCE,
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-strategist-plan-the-week",
        description: "Turn a brand profile and what is going on this week into a dated plan of posts, with a reason for each.",
        body: STRATEGIST_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles", "tinyfish"]),
  }),
  Object.freeze({
    id: "copywriter",
    role: "Copywriter",
    summary: "Writes the week's posts in the client's own voice and checks every line against the do-not-say list.",
    reportsTo: "coordinator",
    instructions:
      "You write the posts. Your whole job is matching one client's register, which you get from the Voice section of their brand profile and from two real sentences of theirs, not from adjectives.\n\nYou write to the network each post is for. A post written once and pasted into three places reads like exactly that, and you do not do it.\n\nYou read every draft against the do-not-say list line by line. Anything that touches it comes out of the batch and is flagged for its own approval; you never quietly soften a banned claim into a permitted one. You write alt text for every image and you say what the image should show, because you are telling the operator what to photograph rather than picking a stock picture.\n\n" +
      MARKETING_APPROVAL_SENTENCE,
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-copywriter-draft-the-posts",
        description: "Write the week's posts in the client's own voice, each one checked against the do-not-say list.",
        body: COPYWRITER_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles", "tinyfish"]),
  }),
  Object.freeze({
    id: "community",
    role: "Community manager",
    summary: "Reads comments and messages, sorts them, and drafts the replies that need one.",
    reportsTo: "coordinator",
    instructions:
      "You handle what people say back. Comments, replies and direct messages on every connected account.\n\nYou sort before you write: a real question, a complaint, praise, spam, and anything naming a live job or a named customer. Questions and praise get a short reply in the client's voice. A complaint gets a draft that acknowledges it and moves the conversation off the public thread, and it always goes to the operator.\n\nThree things never go out in public whatever a profile says: a price, a competitor's name, and admitting or denying a fault. Anything naming a live job or a customer is not answered publicly at all; you report it instead.\n\n" +
      MARKETING_APPROVAL_SENTENCE,
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-community-work-the-replies",
        description: "Read comments and messages, sort them, and draft the replies that need one.",
        body: COMMUNITY_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles", "browser-use"]),
  }),
  Object.freeze({
    id: "ads",
    role: "Paid ads planner",
    summary: "Plans a paid flight against a real budget, with the numbers to watch and the rule that stops it.",
    reportsTo: "coordinator",
    instructions:
      "You plan paid work. You do not buy it and you do not run it: you produce a plan somebody can approve and hand to a platform.\n\nYou need a budget and a window before you plan anything. If you do not have both you ask once, in one question, and stop, because a plan with an assumed budget is a plan nobody can approve.\n\nA plan names the offer from the brand profile, the audience, the networks, the split, and the creative each one needs, separating creative that exists from creative that does not. You write the expected numbers and the stop rule before it runs, as figures and a date. You never invent a reach or cost projection: those are the platform's numbers, and a made-up one is worse than none.\n\n" +
      MARKETING_APPROVAL_SENTENCE,
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-ads-plan-a-flight",
        description: "Plan a paid flight against a budget: audiences, creative, the numbers to watch, and what would make you stop it.",
        body: ADS_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles", "exa"]),
  }),
  Object.freeze({
    id: "analytics",
    role: "Analytics reporter",
    summary: "Reports what last week actually did, every number sitting beside the post that earned it.",
    reportsTo: "coordinator",
    instructions:
      "You report what happened. Every number you give sits beside the post that earned it, because a follower count on its own tells an owner nothing they can act on.\n\nYou say plainly which account you could not reach and why. A report that silently drops a network reads as a network with no activity, which is a lie by omission.\n\nYou compare with the previous window only where the change is bigger than the week-to-week noise you have already seen; a two percent move is not a trend and you do not report it as one. You end with three things that worked and one that did not, each pointing at a specific post, and one line for the strategist about next week.\n\n" +
      MARKETING_APPROVAL_SENTENCE,
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-analytics-weekly-numbers",
        description: "Report what last week actually did, with the numbers beside the posts that earned them.",
        body: ANALYTICS_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles", "browser-use", "notion"]),
  }),
  Object.freeze({
    id: "brand",
    role: "Brand profile keeper",
    summary: "Owns one document per client: voice, audiences, offers, the do-not-say list and who approves.",
    reportsTo: "coordinator",
    instructions:
      "You own the brand profiles. One document per client, and every specialist on this team loads yours before it does anything, so a heading you left blank is a licence for somebody else to invent an answer.\n\nYou read the client's own site and their last month of posts before you ask a single question, then you ask only about what is genuinely not written down anywhere: the do-not-say list, who approves, and which accounts exist. You write the Voice section by quoting them, because two real sentences of theirs are what a copywriter can match and a paragraph of adjectives is not.\n\nThe do-not-say list is the part that earns its keep, and you push for it: what a previous agency got wrong, what legal objected to, what the owner hates seeing. Nothing is not an answer, it is a question you have not asked twice. You keep the template and the worked example untouched so the next client has something to copy.\n\n" +
      MARKETING_APPROVAL_SENTENCE,
    skills: Object.freeze([
      Object.freeze({
        name: "mkt-brand-write-a-profile",
        description: "Interview the operator and turn the answers into a filled brand profile for one client.",
        body: BRAND_KEEPER_SKILL,
      }),
      Object.freeze({
        name: "mkt-brand-profile-template",
        description: "The blank brand profile. Copy it per client, fill every heading, and never leave one empty.",
        body: BRAND_PROFILE_TEMPLATE,
      }),
      Object.freeze({
        name: "mkt-brand-northgate",
        description: "A filled brand profile for Northgate Plumbing, the fixture the gate drives and the example an operator copies.",
        body: BRAND_PROFILE_FIXTURE,
      }),
    ]),
    integrations: Object.freeze(["localfiles"]),
  }),
]);

/**
 * What the operator must provide, said before the Import button rather than discovered after it.
 *
 * The two prerequisites are the ones that strand people, and neither is obvious until you are
 * already stuck behind it: LinkedIn will not let a developer application exist for a company that
 * has no Page, and Meta will not start Business Verification for a business that is not in Business
 * Manager. Both take days of somebody else's time, so they belong on the first screen.
 */
const FIRST_RUN: MarketplaceBotFirstRun = Object.freeze({
  headline: "What to have ready before you import",
  needs: Object.freeze([
    "A brand profile per client. The team ships a blank template and one worked example; the brand profile keeper fills the rest by interviewing you.",
    "TINYFISH_API_KEY, on the TinyFish card. The strategist and the copywriter read the web with it.",
    "BROWSER_USE_API_KEY, on the Browser Use card. This is how the community manager and the reporter reach a network that has no usable API.",
    "NOTION_TOKEN, on the Notion card, if you want the weekly report written into a workspace instead of the chat.",
    "RESEND_API_KEY, on the Resend card, if the coordinator should mail you the week rather than post it in chat.",
    "Add the Filesystem and Exa plugins. Neither takes a key.",
    "A spending limit for this workspace before anything posts through a paid API. Until you set one, the team drafts and stops.",
  ]),
  prerequisites: Object.freeze([
    "A LinkedIn Page has to exist before a LinkedIn developer app can. You cannot create the app first and attach a Page later, so make the Page now if the client does not have one.",
    "A Meta Business has to exist in Business Manager before Business Verification can start, and verification is what an agency posting for a client's Page needs. Neither is instant.",
  ]),
  body:
    "This team drafts. It does not post. Every batch stops at a decision card and waits for your yes, and nothing here has a key of its own until you put one in.\n\n" +
    "No official connector publishes an ordinary post to Facebook, Instagram, X or LinkedIn. Meta's and X's own servers manage apps, webhooks and ads; posting on those three is either the client's own developer app and tokens, or a browser signed in as the client. So the team's posting path is the browser plus whatever scheduler you already pay for, and the social rows in the Marketplace say bring your own app because that is the truth.\n\n" +
    "Import creates seven bots and imports ten documents into this box's shared library. It never installs a connector or writes a key on its own: it lists what is missing and you add each one deliberately. Remove team takes back both the bots and the documents.",
});

const PACK: MarketingTeamBot = Object.freeze({
  id: MARKETING_TEAM_PACK_ID,
  name: "Marketing team",
  creator: "Titanbot team",
  category: "Marketing",
  featured: true,
  tile: Object.freeze({ color: "#c2410c", shape: "squircle" }),
  description:
    "Seven marketing specialists and a coordinator's approval rule. One team, a brand profile per client, and nothing posted until you say yes.",
  instructions:
    "You are the marketing team's coordinator. Import this template and you get seven bots: a coordinator that reports to Titan, a social strategist, a copywriter, a community manager, a paid ads planner, an analytics reporter, and a brand profile keeper.\n\nThey are shared across every client you run. What differs per client is a brand profile: one document holding the voice, the audiences, the offers, the do-not-say list, who approves and which accounts exist. Twenty clients are twenty of those documents against the same seven bots, not twenty teams.\n\n" +
    MARKETING_APPROVAL_SENTENCE,
  skills: Object.freeze(MEMBERS.flatMap((member) => member.skills)),
  integrations: Object.freeze([...new Set(MEMBERS.flatMap((member) => member.integrations))]),
  members: MEMBERS,
  firstRun: FIRST_RUN,
  packaging: Object.freeze({
    agentPrefix: MARKETING_TEAM_AGENT_PREFIX,
    skillPrefix: MARKETING_SKILL_PREFIX,
    capacityRefusal: MARKETING_TEAM_CAPACITY_REFUSAL,
  }),
});

/** Spread into `BOTS` by catalog.ts. A list so a second pack is an entry, not a refactor. */
export const MARKETING_TEAM_BOTS: readonly MarketingTeamBot[] = Object.freeze([PACK]);

/** The member list of a bot row, or an empty list for one that is not a pack. */
export function marketplaceBotMembers(bot: unknown): readonly MarketingTeamMember[] {
  const members = (bot as { members?: unknown } | null | undefined)?.members;
  return Array.isArray(members) ? (members as readonly MarketingTeamMember[]) : [];
}

/** The roster name of one member. The prefix is what `Remove team` recognises. */
export function marketingTeamAgentName(member: { readonly role: string }): string {
  return `${MARKETING_TEAM_AGENT_PREFIX}${member.role}`;
}

/** True for a roster name this pack created. Derived, so it works in a browser that never imported. */
export function isMarketingTeamAgentName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(MARKETING_TEAM_AGENT_PREFIX);
}

/** True for a workflow name this pack imported, for the same reason. */
export function isMarketingTeamSkillName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(MARKETING_SKILL_PREFIX);
}

/**
 * The pack's own invariants, in the catalog's style: a list of problems rather than a throw, so the
 * unit test prints all of them at once and the gate can assert the same list on the wire.
 *
 * `pluginIds` is passed in rather than imported so this can be run against what a BOX actually
 * serves, which is the only list that matters at import time.
 */
export function marketingTeamProblems(
  bots: readonly MarketingTeamBot[] = MARKETING_TEAM_BOTS,
  pluginIds: ReadonlySet<string> | null = null,
): string[] {
  const problems: string[] = [];
  for (const bot of bots) {
    const where = `pack "${bot.id}"`;
    const members = marketplaceBotMembers(bot);
    if (members.length < 7) problems.push(`${where} carries ${members.length} members; the shared platform team is seven`);
    const memberIds = new Set<string>();
    const skillNames = new Map<string, string>();
    const coordinators = members.filter((member) => member.reportsTo == null);
    if (coordinators.length !== 1) {
      problems.push(`${where} has ${coordinators.length} members reporting to Titan; exactly one coordinator does`);
    }
    for (const member of members) {
      const at = `${where} member "${member.id}"`;
      if (memberIds.has(member.id)) problems.push(`${where} declares member "${member.id}" twice`);
      memberIds.add(member.id);
      if (member.role.trim().length === 0) problems.push(`${at} has no role`);
      if (member.summary.trim().length === 0) problems.push(`${at} has no one-line summary for the members list`);
      if (!member.instructions.includes(MARKETING_APPROVAL_SENTENCE)) {
        problems.push(`${at} does not carry the approval rule in its instructions, so it would be a bot that can post without a yes`);
      }
      if (member.reportsTo != null && !members.some((other) => other.id === member.reportsTo)) {
        problems.push(`${at} reports to "${member.reportsTo}", which is not a member of this pack`);
      }
      if (member.skills.length === 0) problems.push(`${at} carries no skill`);
      if (member.integrations.length === 0) problems.push(`${at} names no integration`);
      for (const integration of member.integrations) {
        if (!bot.integrations.includes(integration)) {
          problems.push(`${at} needs "${integration}", which the pack's own integration list does not name`);
        }
        if (pluginIds != null && !pluginIds.has(integration)) {
          problems.push(`${at} needs "${integration}", which is not a plugin this catalog serves`);
        }
      }
      for (const skill of member.skills) {
        if (!skill.name.startsWith(MARKETING_SKILL_PREFIX)) {
          problems.push(`${at} skill "${skill.name}" is not namespaced with "${MARKETING_SKILL_PREFIX}", so a second import would leave a duplicate in the box's shared library`);
        }
        const owner = skillNames.get(skill.name);
        if (owner != null && owner !== member.id) {
          problems.push(`${where} skill "${skill.name}" is claimed by both "${owner}" and "${member.id}"`);
        }
        skillNames.set(skill.name, member.id);
        if (!skill.body.startsWith(`---\nname: ${skill.name}\n`)) {
          problems.push(`${at} skill "${skill.name}" has front matter that does not name it, so the host would file it under something else`);
        }
        if (skill.description.trim().length === 0) problems.push(`${at} skill "${skill.name}" has no description`);
      }
    }
    const packSkills = new Set(bot.skills.map((skill) => skill.name));
    for (const name of skillNames.keys()) {
      if (!packSkills.has(name)) problems.push(`${where} member skill "${name}" is not in the pack's own skill list`);
    }
    if (bot.skills.length !== skillNames.size) {
      problems.push(`${where} lists ${bot.skills.length} skills for ${skillNames.size} distinct member skills; the import would write one of them twice`);
    }
    const packaging = bot.packaging;
    if (packaging == null || packaging.agentPrefix !== MARKETING_TEAM_AGENT_PREFIX || packaging.skillPrefix !== MARKETING_SKILL_PREFIX) {
      problems.push(`${where} does not declare the prefixes Remove team recognises, so an imported team could not be taken back from another browser`);
    } else if (!packaging.capacityRefusal.includes("{room}") || !packaging.capacityRefusal.includes("{needed}")) {
      problems.push(`${where} carries a capacity refusal that names neither number, so the operator would not know what to free up`);
    }
    for (const member of members) {
      if (!marketingTeamAgentName(member).startsWith(packaging?.agentPrefix ?? "")) {
        problems.push(`${where} member "${member.id}" would land on the roster under a name Remove team does not recognise`);
      }
    }
    const firstRun = bot.firstRun;
    if (firstRun == null || firstRun.needs.length === 0) {
      problems.push(`${where} has no first-run message, so the operator finds out what it needs after importing it`);
    } else if (firstRun.prerequisites.length < 2) {
      problems.push(`${where} first-run message names ${firstRun.prerequisites.length} prerequisites; the LinkedIn Page and the Meta Business both strand people`);
    }
  }
  return problems;
}
