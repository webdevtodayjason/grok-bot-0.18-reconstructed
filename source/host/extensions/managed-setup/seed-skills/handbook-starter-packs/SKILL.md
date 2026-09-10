---
name: Starter packs by trade
description: >-
  Use when the owner says what kind of business they run and wants setting up, or asks what
  a shop, a law practice, a course business, a design studio or a marketing team should
  have. It names the real bots, the real jobs, and the offer to make.
---
# Starter packs by trade

**How to read this file.** Every line that starts with `>` is owner language: say it word for word. Everything else is for you.

**There is no flower-shop template.** No legal one, no course-creator one, no freelance-designer one. What the Marketplace actually has is bots, and a pack is a handful of them picked for one trade plus the jobs worth switching on. Say that rather than implying a ready-made thing exists, and never claim a template that is not on the shelf.

> There is no off-the-shelf set for a flower shop, so I would put one together out of what is on the shelf. Want me to set this up for you?

End with that question. Offering four bots and never asking is the half that makes the other half worth anything.

## How you actually do it

1. **SearchBotCatalog** with what they said, in their words. It ranks the shelf and hands back the best rows.
2. **GetBotTemplate** on the one you mean, in full: its facts, its playbooks, its jobs and the apps it wants.
3. **CreateAgentFromTemplate** to set it up. It calls the same thing the console's own Add button calls, so there is one implementation and the two cannot disagree.
4. **Read the answer and say what really happened.** It comes back with counts: facts added, duplicated and refused, playbooks imported, reused and skipped, jobs created and not created, apps connected, addable, informational and theirs to bring. Those counts are the truth. Do not say "done" and leave them unread.

> That one is on your roster now. It came with eleven facts it already knows, seven playbooks and two jobs, and the jobs are switched off until you want them on.

## Three rules that hold for every pack

- **Every job arrives switched off.** Nothing a pack adds starts running on its own. Say so, and offer to switch on the ones they want.
- **A job has a real clock or it is not created.** Five fields, in the box's own local time. Where the words named a cadence and no hour, nine in the morning local is the declared default, and that is disclosed rather than invented. There are no jobs here that run when something happens: no event triggers exist on this product, so never offer one.
- **A fact has to fit.** One remembered fact is capped at 500 characters and a longer one is refused outright rather than quietly cut in half. If the answer reports a refusal, say which fact did not fit instead of reporting a clean run.

## The four blocks they see on a bot's page

Memories are facts it already knows, Skills are playbooks it can run, Routines are jobs that run on their own, Integrations are apps it can use. Use those four words with them: they are the words on the screen.

## A flower shop, or any small shop with a counter

They ask: "Set me up like a flower shop."

> Nothing on the shelf is built for a flower shop, so I would put one together: something watching the diary, something watching deliveries and anything broken, something drafting the replies to customers, something keeping the enquiries straight, and a pass over your website. Want me to set this up for you?

Bots:

- `frank`, **Executive Assistant** (Operations). Keeps the diary straight: what is on today, who is coming in, and who has gone quiet.
- `office-ops-desk`, **Office Ops Desk** (Operations). Watches deliveries and anything broken on the premises, then writes the round-up.
- `customer-question-drafter`, **Product Support Inbox Assistant** (Sales). Finds the answer to a customer question and drafts the reply for you to send.
- `leadsworth`, **Lead Pipeline Desk** (Marketing). Scores the enquiries coming in, merges the duplicates, and flags the ones going cold.
- `site-audit`, **Site Audit** (Marketing). Goes over your website and comes back with a ranked list of what to fix.
- `clip-bot`, **Clip Bot** (Marketing). Finds the good moments in a long recording and cuts them into short captioned clips.

Jobs worth switching on, with the clock each really gets:

- `office-ops-desk` **Daily shipment status**: `0 9 * * 1-5`, Weekdays at 9:00 AM.
- `office-ops-desk` **Weekly facilities digest**: `0 9 * * 1`, Every Monday at 9:00 AM.
- `leadsworth` **Daily lead triage**: `0 9 * * 1-5`, Weekdays at 9:00 AM.
- `site-audit` **Monthly site re-audit**: `0 9 1 * *`, On the 1st of every month at 9:00 AM.

> I would start with two of them rather than all six, because six bots on day one is six things to read. The deliveries one and the enquiries one earn their keep first.

## A personal-injury practice

They ask: "I run a small personal-injury firm. What would you put in for me?"

> There is no legal set on the shelf, so I would build one around the thing that actually loses a case: a promise made on a call and never kept. Something turning every call into a recap and a dated list of what is owed, something answering questions out of your own documents, and something hunting the promises that got left behind.

Bots:

- `call-follow-ups`, **Call Follow-Ups** (Sales). Turns a call into a recap, every promise made on it, and a dated list of what is owed.
- `company-docs-q-a`, **Company Docs Q&A** (Sales). Answers questions out of your own documents and always says which one it came from.
- `follow-through-agent`, **GTM Loop Closer** (Sales). Hunts down promises left behind in meetings and mail, and prepares the reply that closes each one.
- `frank`, **Executive Assistant** (Operations). Keeps the diary straight: what is on today, who is coming in, and who has gone quiet.

Jobs worth switching on, with the clock each really gets:

- `call-follow-ups` **Morning follow-up check**: `0 9 * * 1-5`, Weekdays at 9:00 AM.
- `call-follow-ups` **Weekly call patterns**: `0 14 * * 5`, Every Friday at 2:00 PM.
- `frank` **Exec interview-prep reminder**: `0 9 * * 1-5`, Weekdays at 9:00 AM.

Not created at all, and say so rather than letting them find out:

- `follow-through-agent` **Commitment-strand audit**. This one waits on something this box cannot watch -- an event, or an hour you have not picked yet -- so adding the bot does not create it. Add it yourself from the routines panel when you know the cadence.

> One of its jobs has no clock on it, so it does not get switched on at all when I set it up. Tell me what time of day you want it and I will add it myself.

> Nothing here reads a privileged file unless you connect it to one, and nothing sends anything to anybody without you saying yes first.

## A course business

They ask: "I sell online courses. Can you help me keep up with the content?"

> There is no course-creator set on the shelf either, so I would build one around the recording: something turning a lecture into notes and a revision sheet, something finding the clips worth cutting out of a long video, something cutting and captioning them, and a writing partner for the emails and the pages.

Bots:

- `course-note-taker`, **Course note-taker** (Personal). Turns a lecture, a video or a reading into notes and a revision sheet.
- `clip-bot`, **Clip Bot** (Marketing). Finds the good moments in a long recording and cuts them into short captioned clips.
- `best-video-editor`, **Video Edit Desk** (Marketing). Turns raw footage into cut clips, burned-in captions and the right size for each place.
- `writing-bot`, **Writing Bot** (Marketing). A writing partner for drafting and revising, working in your own words rather than over them.
- `human-copywriter`, **Copy Humanizer** (Marketing). Edits a draft so it reads like a person wrote it, shows every change, and invents nothing.
- `luma-pages`, **Luma Pages** (Marketing). Builds and keeps the event pages: the copy, the sign-up settings, the capacity and the waiting list.

Jobs worth switching on, with the clock each really gets:

- `clip-bot` **Clip queue pass**: `0 9 * * 1-5`, Weekdays at 9:00 AM.
- `clip-bot` **Friday clip recap**: `0 9 * * 5`, Every Friday at 9:00 AM.
- `best-video-editor` **Weekly cut queue**: `0 9 * * 1`, Every Monday at 9:00 AM.
- `human-copywriter` **Weekly shipped check**: `0 14 * * 5`, Every Friday at 2:00 PM.

> The clipping jobs want somewhere to put recordings, so the first thing to do after I set them up is show me where the files live.

## A freelance designer

They ask: "I design on my own for a handful of clients. What is worth having?"

> There is no freelance-designer set on the shelf, so I would build one around review and handover: something critiquing a screen with ranked fixes, something turning a frame into a build spec and watching the component set for drift, something writing the alt text, and something pulling the stills out of your footage.

Bots:

- `critiquito`, **Critiquito: Design Critique** (Design). Turns a screenshot or a design link into a critique with ranked, concrete fixes.
- `figma-bro`, **figma bro** (Design). Turns a design frame into a build spec, and checks the component set for drift.
- `imogen`, **Imogen** (Design). Writes short, copyable alt text for an image so a blind reader gets the important part.
- `image-gen-bot`, **Stills & Clips Desk** (Marketing). Pulls stills, thumbnails and short clips out of footage, sized for where they are going.
- `sable-game-art`, **Game Art Director** (Design). Turns a game concept into a style guide, palettes and prompt sheets for your image tool.

Jobs worth switching on, with the clock each really gets:

- `critiquito` **Weekly open fixes**: `0 9 * * 1`, Every Monday at 9:00 AM.
- `figma-bro` **Weekly library check**: `0 9 * * 1`, Every Monday at 9:00 AM.
- `figma-bro` **Ready for dev sweep**: `0 14 * * 5`, Every Friday at 2:00 PM.
- `image-gen-bot` **Weekly pull queue**: `0 9 * * 1`, Every Monday at 9:00 AM.

> Your design tool is not one of the apps this product carries, so these work from a pasted link or a screenshot rather than reaching into the file. That is enough for a critique and a spec, and I will say so rather than pretending otherwise.

## A marketing team, which is the one real pack on the shelf

They ask: "Can you run my social media for me?"

> This one does exist as a set rather than something I put together: a coordinator and six specialists, with one profile per client holding the voice, the audiences and the list of things never to say. It drafts and it stops. Nothing goes out anywhere until you say yes.

**A team does not come through your tools.** `marketing-team` is one row carrying 7 bots: Coordinator, Social strategist, Copywriter, Community manager, Paid ads planner, Analytics reporter, Brand profile keeper. The coordinator reports to you and the other six to the coordinator.

**CreateAgentFromTemplate refuses it**, in plain words, and points at Marketplace, then Bots, then the Import team button. Through your tool it would make ONE bot carrying the pack's name and none of its members, which looks like it worked, so the refusal is deliberate.

**A refusal is not a success.** This has already gone wrong once: a bot searched the shelf, this pack came back first, it was told to use it, the import refused it, and the bot answered "Done, Marketing team is set up and on your roster" having created nothing at all. Handed a refusal, say it was refused and say where the button is.

> That one is a team rather than a single bot, so it gets added from its own page: Marketplace, then Bots, then Import team. That puts all seven on at once. I cannot do it from here.

It carries playbooks and no jobs, so there is nothing to switch on afterwards. Nothing it writes goes out anywhere until somebody says yes, and that rule is in all seven of them.

## What to do when nothing on the shelf fits

Say so. Name the two or three closest rows with a line each, say what they do and do not cover, and ask whether they want one of those or one built from scratch. Both are real answers. Inventing a row that is not there is not.

> There is nothing on the shelf built for exactly that. The closest two are these, and here is what each would and would not cover. Do you want one of those, or shall I build you one from scratch?
