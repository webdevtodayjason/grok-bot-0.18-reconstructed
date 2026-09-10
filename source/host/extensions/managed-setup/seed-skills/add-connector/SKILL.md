---
name: add-connector
description: >-
  Walk through connecting a new MCP connector — search the catalog, install, and
  authenticate.
---
# Add a connector

Help the user connect a new MCP connector — an integration like GitHub, Slack, Linear, or Google Workspace — so you can use it on their behalf. A connector ships inside a plugin from **the Marketplace**, this box's own catalog, and installing one writes its entry on the box; you manage them with SearchPlugins, GetPlugin, InstallPlugin, AddMcpServer, UninstallMcpServer, GetMcpServerStatus, and AuthenticateMcpServer. Say "connector" to the user — "plugin", "MCP server", and "plugin id" are plumbing vocabulary. Work through the steps below, adapting to whatever the user has already told you.

**For the words you say to the person**, read `/home/box/agent-data/managed-skills/skills/handbook-connect-an-app/SKILL.md`: it carries the plain-words playbook per app, the one box they fill in themselves, and what you never ask for in the chat.

## 1. Figure out what they want to connect
- If the user named a service (as an argument to this workflow or anywhere in their message), use that.
- If not, ask which service they want to connect with one short SendMessage, then wait for their reply.

## 2. Find it (SearchPlugins)
Call SearchPlugins with what you're after in natural language — the service name works. It searches the Marketplace catalog and is read-only, so it needs no confirmation. Every result carries a STABLE plugin id, an install state, and what it includes; branch on that:
- **`installed=yes`**: don't reinstall. Check what's behind it — GetPlugin lists the plugin's MCP servers with their ids and statuses, and GetMcpServerStatus shows the same runtime view across everything. If a server reads needsAuth, go to step 4. Otherwise tell the user it's already connected and offer to manage it instead (e.g. save usage instructions with SetMcpInstructions, or reconnect a stuck one with RestartMcpServers).
- **`installed=no`**: install it (step 3). If several entries plausibly match an ambiguous name, send a question widget listing only the real matches and let the user pick — never invent options.
- **Nothing matches**: go to step 5.

## 3. Read the detail, confirm, then install
- Call GetPlugin with the plugin id first. SearchPlugins does not resolve credential fields, so this is the only place the fields, whether the host already holds each one, and what the plugin adds show up — read it before you describe the install to the user.
- Installing changes the user's configuration, so confirm with a question widget (e.g. prompt "Add the <name> connector?", options Yes / No). A question widget ends your turn — stop and wait for their answer. Installing in the same turn as the widget is refused outright, so install on your next turn.
- After they say yes, call InstallPlugin with the plugin id from SearchPlugins — never a display name.
- **You cannot set a key.** Leave `values` out; the user stores every credential themselves on the plugin's page (Marketplace → Plugins → the plugin → Accounts), because a key typed into this conversation would sit in the transcript. After the install, say in plain text which field they need to fill and where, then end your turn. Never ask them to paste a key to you.
- A shell tool (a CLI like the CodeRabbit one) is not installed by InstallPlugin: its install command runs inside the box from that same page. Say so instead of retrying.
- Newly installed tools become available on your NEXT message, not the same one.

## 4. A key, or a sign-in
Two different things land a connector short of working, and telling them apart is the whole of this step.

- **It needs a KEY.** This is nearly every connector here: a program the box runs with the key in its environment, or an endpoint it calls with the key in a header. GetMcpServerStatus says so in a sentence ("It needs its key before it can connect"). You cannot set it, and you must not ask for it in chat, because a key typed here stays in the transcript. Tell the user in plain text which field to fill and where (Marketplace, the connector's page), then end your turn. AuthenticateMcpServer does nothing for these and will refuse.
- **It needs a browser SIGN-IN.** Only these read needsAuth. The connect card is host-authored: InstallPlugin and AddMcpServer emit it themselves for a connector that lands needsAuth, and AuthenticateMcpServer emits it when you start auth directly. You cannot compose one: SendMessage has no connector content type.
- So after an install there is usually nothing to do here either way. Call AuthenticateMcpServer only when a connector that was already installed reads needsAuth, or an MCP tool call fails with an auth error. Pass the stable server id from GetMcpServerStatus, never a display name; if the tool's schema also takes an `account_label`, pass the label the status listing shows (`default` for a single unlabeled account).
- Never paste an authorization link into chat, and never reach the same service another way while its authorization is pending.
- Once the card is up, finish any unrelated work and end your turn: the user authorizes in place and you are resumed automatically, so don't ask them to report back. Afterwards you can confirm with GetMcpServerStatus.

## 5. No Marketplace match: add it yourself
The Marketplace has an "Add your own" card for exactly this, and AddMcpServer is the same door from here. Point the user at the card when they want to do it themselves; use the tool when they'd rather you did. Confirm with a question widget first either way.

Two shapes, and the server's own docs tell you which:

- **A link.** The service publishes an https MCP endpoint. Call AddMcpServer with `url`, and `type` only if the docs say SSE. The box connects to it directly.
- **A program.** The docs give an `npx` or `uvx` line. Call AddMcpServer with `command`, `args` and `env` instead. Pin the version in `args`. It runs inside this user's box, as the box's own root user, and the same connector is there for all of this user's agents, so say that when you confirm. Install anything the command needs with Shell first.

**The key never passes through you.** Write a header as a placeholder naming the field, for example `{"Authorization": "Bearer ${ACME_TOKEN}"}`, and pass `env` as NAMES only, for example `["ACME_TOKEN"]`. Then tell the user which field to type into the masked box on that connector's page. Putting the value in the tool call is refused, and rightly: it would sit in this transcript forever. A key in the URL itself is refused for the same reason.

A server that can only be signed into through a browser cannot be added this way. Say so plainly and stop, rather than adding it and leaving it waiting on a window nobody is looking at.

If there's no connector, no endpoint and no command, tell the user it isn't available to connect yet rather than pretending. If it's just a website behind a login, you can instead reach it through your computer's browser.

## Wrap up
Once it's connected, confirm in a short SendMessage and, when useful, offer a first concrete thing you can now do with the new connector.
