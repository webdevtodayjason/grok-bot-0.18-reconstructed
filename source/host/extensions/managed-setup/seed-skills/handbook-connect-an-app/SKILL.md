---
name: handbook-connect-an-app
description: >-
  Use when the owner wants one of their own apps joined up to you, asks what you can plug
  into, or offers you something private in the conversation. It carries the one place a
  private value goes, the plain words for it, and the playbook for every app here.
---
# Connecting an app for the owner

**How to read this file.** Every line that starts with `>` is owner language: say it word for word. Everything else is for you. The owner never hears a field name, a vendor's own label for one, or any of the words this product keeps off a customer's screen.

## The rule, and it has no exception

You install. They store the private value. You never see it and you never ask for it in the conversation, because anything typed into a chat sits in the transcript, in your own context, and in whatever window that conversation was later compacted into. There is no taking it back out. Two places take one, and both are masked boxes that never show it to you:

1. **The app's page.** Marketplace, then Plugins, then the app, then the box headed **Accounts**: one masked box per thing that app needs, the vendor's own line under it, and **Store on the host**. You cannot fill it. There is no tool for it, deliberately.
2. **A masked card you raise yourself.** `SendMessage` with `type: "secret-request"` and `{label, description, connector, field}` draws a card with a masked box and a **Save securely** button; the value goes straight to the store and into neither the transcript nor the page. Use it when sending them to a panel would lose them. `connector: "shell"` puts it in this agent's own shell instead and the field name must then be UPPERCASE.

Say the path with the app's name in it, and say the custody in the same breath:

> Marketplace, then Plugins, then Todoist, then the box headed Accounts. Whatever you type in there never reaches me.

If they paste one into the chat anyway, do not repeat it back, not even a few characters of it:

> Do not paste that to me. Anything in our chat stays in the conversation for good and I cannot take it back out. Put it in the masked box instead. And because that one has been in a chat window, go and replace it where you made it.

## The four states they can read back to you

- **Not installed.** The app is not on the box yet. Press Add on its card.
- **Needs auth.** It is on the box and at least one box on the Accounts row is still empty.
- **Ready.** On the box, filled in, and talking. This is the one you are waiting for.
- **Connecting.** On the box, nothing left to fill in, and no tool list back yet. It can take the best part of a minute. It is not a blink to ignore: it means the app is written down and the box has not heard back.

> It will say Connecting for a moment and then Ready. Ready is the one that means it worked.

## 14 apps want something filled in, 17 boxes in all

Never say one box per app. It is one box per thing the app needs, and two rows need more than one. The minted-at line under each is the vendor's own wording out of the catalog: it is yours to know, not to read out. GetPlugin hands you the rest of it when you need the permissions.

**GitHub** (Development). Read repositories, issues and pull requests. One box.
> the one thing GitHub gives you when you make a connection for me.
  Minted at: Create one under Settings → Developer settings → Personal access tokens → Fine-grained tokens (github.com/settings/personal-access-tokens/new).

**Slack** (Communication). Read channels, threads and search as yourself. One box.
> the one thing Slack gives you after you install the little app in your own workspace.
  Minted at: Create the app at api.slack.com/apps, add User Token Scopes, Install to Workspace and copy the User OAuth Token.

**Linear** (Project management). Read issues, projects and cycles. One box.
> the one thing Linear gives you on your own account security page.
  Minted at: Create one under Settings → Account → Security & Access → Personal API keys (linear.app/settings/account/security) and copy it once.

**Google Workspace** (Documents & Files). Gmail, Docs and Drive through one server. 3 boxes.
> the first of three things Google gives you, the name of the connection.
  Minted at: Create it in Google Cloud under APIs & Services → Credentials with https://developers.google.com/oauthplayground as an authorized redirect URI, on a project with the Gmail, Google Docs and Google Drive APIs enabled.
> the second of the three, the private half that goes with that name.
  Minted at: The secret shown beside that same OAuth client under APIs & Services → Credentials.
> the third of the three, the long one the sign-in page hands back at the end.
  Minted at: The refresh token from the OAuth 2.0 Playground exchange (gear → Use your own OAuth credentials → Authorize APIs → Exchange authorization code for tokens), not the access token.

**TinyFish** (Web & Search). Web search, page fetch and browser automation. One box.
> the one thing TinyFish gives you on your own dashboard.
  Minted at: Your TinyFish account's API key, from the dashboard at agent.tinyfish.ai.

**Notion** (Documents & Files). Read and write pages and databases. One box.
> the one thing Notion gives you when you create an integration.
  Minted at: An internal integration token (ntn_...) from notion.so/profile/integrations — create the integration, then open each page or database you want reachable and use its ••• menu → Connections → your integration.

**Airtable** (Business). Read and update bases, tables and records. One box.
> the one thing Airtable gives you when you create access for me.
  Minted at: A personal access token (pat...) from airtable.com/create/tokens, scoped to the bases you want reachable.

**Todoist** (Project management). Read and manage tasks and projects. One box.
> the one thing Todoist gives you under Settings, Integrations, Developer.
  Minted at: The API token from Todoist under Settings → Integrations → Developer.

**Resend** (Business). Send email from your own domain. One box.
> the one thing Resend gives you for sending, not the full-access kind.
  Minted at: An API key from resend.com/api-keys.

**Stripe** (Business). Look up customers, invoices and payments. One box.
> the restricted one Stripe gives you, never your main one.
  Minted at: A RESTRICTED key (rk_...) from the Stripe dashboard under Developers → API keys → Create restricted key, not your secret key.

**Browser Use** (Web & Search). Hand a browsing job to a hosted agent. One box.
> the one thing Browser Use gives you under Billing.
  Minted at: An API key from cloud.browser-use.com under Billing → API keys.

**Buffer** (Marketing). Schedule posts to eleven networks, and you can set it up yourself. One box.
> the one thing Buffer gives you under its own Settings.
  Minted at: A key from Buffer's own Settings → API, minted by you with no application to file.

**CodeRabbit CLI** (Code review). Run an AI code review from the box's shell. One box.
> the Agentic one from your CodeRabbit account, not the user or workspace kind.
  Minted at: An Agentic API key from app.coderabbit.ai/settings/api-keys (app.eu.coderabbit.ai for EU accounts).

## 6 apps want nothing at all

Press Add and they work. No box, so nothing to ask for and nothing to wait on.

- **Context7.** Up-to-date documentation for any library.
- **Exa.** Search the web and read the pages it finds.
- **Cloudflare docs.** Search Cloudflare's own documentation.
- **DeepWiki.** Ask questions about any public repository.
- **Playwright browser.** Drive a real browser inside the box.
- **Filesystem.** Read and write files in the box's workspace.

> That one needs nothing from you. I can turn it on myself and use it in my next message.

## 4 rows put nothing on the box at all

Pages, not switches. No official connector publishes an ordinary post to Facebook, Instagram, X or LinkedIn anywhere, so there is nothing to install and nothing to fill in. A row is allowed to be a page: a box for a value nothing reads would be the same lie one level up. What the page carries is what somebody has to do first, and it takes weeks rather than an afternoon.

**Meta: Facebook Pages and Instagram** (Marketing). What Meta needs before an agent can post for a client. Nothing to install and nothing to fill in: read the page with them and say what it will cost in time.

**X** (Marketing). What posting to X costs, and why it needs your own app. Nothing to install and nothing to fill in: read the page with them and say what it will cost in time.

**LinkedIn** (Marketing). The application, the page, and the sixty-day clock. Nothing to install and nothing to fill in: read the page with them and say what it will cost in time.

**Browserbase** (Web & Search). A cloud browser the agent can drive, with a live view a person can take over. Nothing to install, and still 2 boxes, read by the product itself rather than by any bot.
> the private one from your Browserbase Settings page.
  Minted at: A key from the Browserbase dashboard under Settings.
> the project id on that same Browserbase Settings page.
  Minted at: The project id from the same Settings page.

> Nobody's connector can put an ordinary post on that for you. What works is your own developer app, or a scheduler you already pay for, or a browser somebody is signed in to. I can drive the browser while you sign in.

## 3 rows also install a command inside the box

A command-line program the agent runs itself, rather than a server the box talks to. Add runs the vendor's own installer inside the box as root, capped at five minutes, and the state afterwards is asked of the box rather than read out of a file. There is no Uninstall for one of these on this host, so say so before you add one.

- **GitHub** runs `gh`. Installed when `command -v gh` answers.
- **TinyFish** runs `cli-anything-tinyfish`. Installed when `command -v cli-anything-tinyfish` answers.
- **CodeRabbit CLI** runs `cr`. Installed when `command -v cr` answers.

## Add your own, the one row your own tool refuses

**Add your own.** Connect any MCP server, from a link or a command. Its Add opens an editor in the console. Your InstallPlugin refuses it and explains why rather than writing anything, because there is nothing to write. Send them to the card; do not try the tool and report the refusal as a failure. With this one, seven rows ask for nothing at all. Neither door signs in through a browser: a server that can only be authorized by a person clicking through says so and stops, rather than waiting on a window nobody is watching. One such bridge on a test box had been waiting nine hours and fifty-one minutes when it was found.

## The worked example, start to finish

They keep their to-do list somewhere and ask how you get into it.

> Your to-do list is one I can work. Marketplace, then Plugins, then Todoist, then the box headed Accounts. There is one thing to fill in: the one thing Todoist gives you under Settings, Integrations, Developer. Paste it there and press Store on the host. I never see it and I cannot fill it in for you.

Yours to know and not to read out: "The API token from Todoist under Settings → Integrations → Developer. It is account-wide and cannot be narrowed, so add this on an account whose whole task list you are willing to expose." Account-wide is the part that matters: if their whole task list is not something they want reachable, the honest answer is a second account, not a narrowing that does not exist.

First run is slow and the rest are not. Measured on a box with nothing cached: 24.9 seconds the first time, 2.1 seconds warm. Do not report the first wait as a failure.

> It will take half a minute the first time and then be quick. Tell me when the row says Ready and I will have a look at what is in there.

Then press on. When the row says Ready, do one concrete thing with the app and say what you found: a connection nobody used is not proof of anything.

## Two refusals you will meet, and neither is a bug

- **A value typed into a header, or carried in a web address, is refused** with the field it wants named instead. The refusal does not repeat the value back, and neither do you. Write a header as a placeholder naming the field, and pass environment variables as NAMES only.
- **A team pack is refused by the import verb** and points at the console. A refusal is not a success: never answer "done" to one. The starter packs pack carries that case with the measured failure.
