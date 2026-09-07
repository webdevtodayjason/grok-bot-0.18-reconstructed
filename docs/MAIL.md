# Agent email (MAIL-1)

**Status:** contract written 2026-09-06 from Jason's spec ("@titanbot email via Resend send+receive").
The product is Titanium Bot at titanium.bot and the console is console.titanium.bot. Row `MAIL-1` in
`GAP-ANALYSIS.md` tracks the build.

Every agent gets an email address at the operator's domain. Titan is `titan@titanium.bot`. Mail sent
to an agent lands in that agent's conversation as a message it can act on, and the agent sends and
replies from its own address. This file is both the operator README and the contract the pieces are
built to. Every name below is binding: routes, status codes, file paths, settings names, and the
shape of the prompt an agent is handed.

## 1. Where it lives

```
Resend ──HTTPS──► relay (ui/server.mjs + ui/mail-edge.mjs)    receive: signature, routing, ledger
                     │  gateway command sendPrompt, relay's own bearer
                     ▼
                  gateway (host bundle in the box)            the mail arrives as a prompt
                     │
                  agent's conversation                        it reads it and answers

agent's shell ──HTTPS──► api.resend.com/emails                send: curl and $RESEND_API_KEY
```

- **The relay owns the receive side.** `ui/mail-edge.mjs` is a new module wired from `ui/server.mjs`
  the way `handleJobBus` is: a branch at the top of the request handler, before the console login,
  because Resend holds no console session and never will. Nothing in the host bundle changes for the
  receive side.
- **The relay owns the settings.** They live in `ui/mail.json` next to `ui/subscriptions.json`, mode
  0600, chowned to the parent directory's owner through `ownLikeParent` like every other file the
  relay writes. The relay runs as root in its container, and a root-owned file in that tree broke the
  R750 backup once already.
- **Secrets are write-only.** The console can set them or clear them. Nothing reads them back, not
  the console, not the gate, not a log line. The settings read reports "set" or "not set" and
  nothing else.
- **The send side is the agent's own shell.** No new tool. The operator gives each agent
  `RESEND_API_KEY` through the secure card (connector `shell`, field `RESEND_API_KEY`), which the
  ENV-1 fan-out pushes into every window daemon, and the agent runs `curl`. The `email` skill is what
  tells it how.

## 2. Settings

`ui/mail.json`, written by the relay only:

| Field | What it is |
|---|---|
| `enabled` | Whether the receive side accepts mail at all |
| `domain` | The operator's mail domain, e.g. `titanium.bot` |
| `fromName` | The display name on outbound mail |
| `apiBase` | The Resend API base, default `https://api.resend.com`; the gate points it at a stub |
| `apiKey` | The Resend API key. Write-only |
| `webhookSecret` | The Svix signing secret Resend shows when the webhook is created, `whsec_...`. Write-only |
| `catchAllAgentId` | The agent that gets mail no name matches |
| `routes` | `{ "<localpart>": "<agentId>" }` for addresses that are not an agent's name |

## 3. Routes on the relay

### `POST /hooks/resend` (public: no session, no bearer)

This is the URL pasted into Resend, so it answers for itself. It is not behind the console login and
it never carries the `x-relay-auth` marker.

- Body cap 256 KB. Over that it is 413, drained then ended the way the login's oversize refusal is,
  because destroying the request behind Cloudflare and Traefik turns a 413 into a proxy 502.
- Rate limit 60 a minute per client address, in memory, the same shape as the login lockout.
- With no `webhookSecret` stored: `503 {"error":"not_configured"}`.
- The signature is checked by hand with `node:crypto`, no dependency. Signed content is
  `<svix-id>.<svix-timestamp>.<raw body>`; the key is the base64 bytes of the secret after the
  `whsec_` prefix; the expected value is `base64(HMAC-SHA256)`; the `svix-signature` header is
  space-separated `v1,<base64>` entries and any one of them may match; the timestamp has to be
  within 300 seconds; every comparison is `timingSafeEqual`. Ported from
  `~/code/titanium-mail/apps/web/lib/svix.ts`, which is the tested original.
- A bad or missing signature: `401 {"error":"invalid_signature"}`.
- **Everything else answers 200**, so Resend stops retrying: a type that is not `email.received` is
  `{"ignored":"type"}`, an `email_id` already in the ledger is `{"ignored":"duplicate"}`, an address
  that routes to no agent is `{"ignored":"no_route"}`, and a Resend fetch that fails is
  `{"ignored":"fetch_failed"}` and is logged.
- The full message comes from `GET {apiBase}/emails/receiving/{email_id}` with
  `Authorization: Bearer <apiKey>`, 15 second timeout. Every field on it is optional: `from`, `to`,
  `subject`, `text`, `html`, `headers`, `message_id`, `created_at`. Attachments come from
  `GET .../emails/receiving/{email_id}/attachments` and only their name, content type, size,
  download link and expiry are read. **Nothing is downloaded.**
- **Routing.** Take the To addresses, the event's `data.to` first and then the fetched `to`. For each
  one, lowercase the localpart and drop any `+tag`. The first address whose domain equals
  `settings.domain` wins; if none does, the first address wins. Then, in order: an agent from the
  gateway's `listAgents` whose name matches case-insensitively with spaces and dashes removed, so
  "chief of staff" matches `chiefofstaff`; else `settings.routes[localpart]`; else
  `settings.catchAllAgentId`; else the agent named Titan; else no route.
- **Delivery** is the gateway command `sendPrompt` with `{agentId, prompt, clientNonce: "mail:" +
  email_id}`, sent through the relay's existing upstream helper, so the gateway bearer never leaves
  the relay. The prompt is plain words, with at most 20000 characters of body (the `text`, or the
  `html` with its tags stripped):

  ```
  Email received at <to address>
  From: <from>
  Subject: <subject>
  Date: <created_at>
  Message-ID: <message_id>

  <body>

  Attachments: <name> (<type>, <size>) <download_url> (link expires <expires_at>)

  You can reply from your own address (<agent localpart>@<domain>); the email skill shows how,
  and a reply must carry In-Reply-To: <message_id> so it threads.
  ```

  One attachment line each, or `none`.
- Every event appends one line to `ui/mail-inbox.jsonl`:
  `{at, email_id, message_id, from, to, subject, agentId, agentName, outcome}`. **No bodies and no
  secrets go in that file.**
- A delivery answers `200 {"delivered":{"agentId","agentName"}}`.

### `GET /mail/settings` (console session, like every other relay-local read)

```json
{ "enabled": true, "domain": "titanium.bot", "fromName": "Titan", "apiBase": "https://api.resend.com",
  "catchAllAgentId": null, "routes": {}, "apiKeySet": true, "webhookSecretSet": true,
  "webhookUrl": "https://console.titanium.bot/hooks/resend",
  "addresses": [{ "agentId": "...", "name": "Titan", "address": "titan@titanium.bot" }],
  "recent": [ /* the last 20 ledger rows */ ] }
```

`webhookUrl` is built from the request's own host. `addresses` is every agent on the roster, at
`<name lowercased, spaces removed>@<domain>`. Neither secret's value appears anywhere in this
answer.

### `POST /mail/settings` (console session)

A partial update. `enabled`, `domain`, `fromName`, `apiBase`, `catchAllAgentId` and `routes` are
written when present. `apiKey` and `webhookSecret` are **set when a string, cleared when `null`, and
left alone when absent** so the console never has to send back a value it cannot read. The answer is
the same shape as the GET, and it echoes neither secret.

## 4. The console card

Settings, beside the Job bus card: the domain, the sender name, the catch-all agent picked from the
roster, the webhook URL to paste into Resend (read only, with a copy button), the two write-only
secret fields each showing "set" or "not set" with a Clear action, every agent's address, and the
last received rows with the time, the sender, the subject, and who it went to. It reads and writes
the two relay routes above through `gateway-adapter.js`, a relay-local fetch, not a gateway command,
the same way the job bus settings do.

## 5. The `email` skill

`source/host/extensions/managed-setup/seed-skills/email/SKILL.md`, the same place as
`learn-from-demonstration` and `add-connector`. It shows the agent its own address, how to check that
`$RESEND_API_KEY` is set and how to ask for it with a secure card if it is not, the send call, the
reply call with `In-Reply-To`, what to do with attachment links, and the one hard rule: never put the
key in a message, a file, a commit or a log line.

Skills reach the box inside the host bundle, because the host ships as one file and cannot read them
off disk at runtime. After any edit to that SKILL.md:

```bash
node scripts/gen-seed-skills.mjs      # rewrites seed-skills.gen.ts from the markdown
node scripts/build-host.mjs --deploy  # builds and restarts the box
bash scripts/bundle-identity.sh       # the box is running the bundle that was just built
```

## 6. Operator steps, in order

1. **Verify the domain in Resend.** Resend gives DNS records for `titanium.bot`; add them at
   Cloudflare and wait for Resend to show the domain as verified. Sending fails with a 403 about the
   domain until this is done.
2. **Turn on receiving and add the MX record.** In Resend, enable inbound for the domain and add the
   MX record it shows at the **apex** of `titanium.bot`. Mail cannot arrive without it.
3. **Create the webhook.** In Resend, a new webhook for the `email.received` event, pointing at the
   URL the console card shows, which is `https://console.titanium.bot/hooks/resend`. Resend shows a
   signing secret starting `whsec_` once. Copy it now.
4. **Fill the console card.** Console, Settings, the Email card: the domain, the sender name, the
   signing secret in the webhook field, the Resend API key in the key field. Both fields go
   write-only the moment they are saved, so keep your own copy of the key in your password manager.
   Turn the card on.
5. **Give each agent the key.** For every agent that should be able to send: open the agent, use the
   secure card for connector `shell`, field `RESEND_API_KEY`, and paste the key. The value lands in
   that agent's shell environment. An agent can also ask for it itself; the `email` skill tells it
   how.
6. **Check it.** Send a mail to `titan@titanium.bot` from your own inbox. It should appear in Titan's
   conversation within a few seconds, and as a row in the Email card's recent list. Ask Titan to
   reply and check that the reply threads under your original.

If mail does not arrive, look at the card's recent rows first. A row with `no_route` means the
address matched no agent, `fetch_failed` means the API key is wrong or Resend was unreachable, and
no row at all means the webhook never got through, so check the URL in Resend and that the signing
secret in the card is the one that webhook shows.

## 7. The gate

```bash
node scripts/verify-mail.mjs --url https://console.titanium.bot            # read only, safe live
node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub           # the full run
```

It speaks HTTP to the relay and nothing else. Without `--stub` it changes nothing: the console door
in front of `/mail/settings`, the shape of that answer, that the answer withholds both secrets, that
an unsigned `POST /hooks/resend` is refused by the webhook rather than by the console login, and that
an oversized body is refused rather than buffered.

With `--stub` it also runs a stub Resend API of its own, writes a generated signing secret and a
generated key, delivers one signed synthetic `email.received` to the first agent's address, and then
checks the ledger row, a forged signature, a replayed `email_id`, and the withholding again. It puts
the settings back at the end, including on SIGTERM and SIGINT, and it **refuses to start the stub run
at all when the relay already holds a key or a signing secret**: those are write-only, so the gate
cannot put back what it cannot read, and clearing a live Resend key to finish a test run is not a
trade a gate gets to make.

The delivery leg really does put a message in the first agent's conversation. That is the product.
The subject says the mail came from the gate.

When the relay is not on this machine, the stub has to be reachable from the relay, so pass
`--stub-base <url>`; the stub then binds `0.0.0.0` and listens on that URL's port.

Exit codes: `0` every check passed, `1` a check failed, `2` the run could not start.

**Measured so far.** The relay module does not exist yet, so the gate has been run against a
throwaway mock of this contract on the Mac (2026-09-06): 24 of 24 with `--stub`, 10 of 10 read-only,
exit 1 against a mock rigged to echo the key back, exit 2 against a mock that already held one, and
the settings correctly restored after a SIGTERM in the middle of a run. **Not yet measured:** a real
`ui/mail-edge.mjs`, a real Resend account, and anything at all on the R750. The gate is the
acceptance test for the relay half when someone builds it.
