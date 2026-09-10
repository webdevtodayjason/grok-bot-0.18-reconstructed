---
name: handbook-what-i-can-do
description: >-
  The shape a capability block has to have. This is the validator's own fixture, not a shipped
  pack.
---
# The shape of the map (fixture)

This file is NOT seeded. It lives under `tests/fixtures/` so `scripts/verify-handbook.mjs --offline`
can be proved to accept a conforming pack and refuse a broken one, and so whoever writes the real
`handbook-what-i-can-do` can see the block shape rather than infer it. The real pack is at
`source/host/extensions/managed-setup/seed-skills/handbook-what-i-can-do/SKILL.md`.

The other four packs this one indexes: handbook-plain-words, handbook-connect-an-app,
handbook-starter-packs, handbook-never-ask.

### Talk to me and to the crew
- They ask: can I just talk to you, and who are the others?
- True today: every bot here has its own conversation, and I run the others and bring answers back.
- Where it lives: the roster down the left of the console.
- What I say first: You talk to me, and I hand work to whichever of us it belongs to.

### Give a bot a job that runs on its own
- They ask: can you do this every Monday without me asking?
- True today: a job runs on a clock I set with you, and it arrives switched off until you say go.
- Where it lives: the Routines panel beside this conversation.
- What I say first: Pick a day and an hour and I will put it on the list for you.

### Email in and out
- They ask: how do I get you reading my email?
- True today: I have an address of my own, and mail sent to it lands here as a message.
- Where it lives: your account page, under the bot's own details.
- What I say first: Send one to my address and you will watch it arrive here.

### Use the web
- They ask: can you go and look at a website for me?
- True today: I have a browser on my own screen and you can watch me use it.
- Where it lives: the Browser panel, and the screen itself under Desktop.
- What I say first: Tell me the page and I will go and read it.

### Write a small program
- They ask: can you build me something that does the sums?
- True today: real code goes to a separate machine made for it, and the files come back to mine.
- Where it lives: the Files panel of this conversation.
- What I say first: Tell me how you work it out today and I will start from that.
- Not yet: on a workspace somebody runs themselves this is turned off and says so (docs/CODE.md:288).

### Get it on your phone
- They ask: can I have this on my phone?
- True today: the console works in your phone's browser, and you choose what wakes it.
- Where it lives: Settings, then Notifications.
- What I say first: Open it in your phone's browser and I will turn the alerts on with you.
- Not yet: there is nothing to install from a store (docs/APPS.md:48).

### Sit in on a meeting
- They ask: can you take notes in my meetings?
- True today: nothing yet. I say so rather than offering it.
- Where it lives: nowhere on screen today.
- What I say first: Not something I can do yet, so I will not promise it.
- Not yet: designed and not built (docs/GAP-ANALYSIS.md:346).
