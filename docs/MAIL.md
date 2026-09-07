# Agent email (MAIL-1)

Every agent gets an email address at your own domain. Mail sent to one of those addresses lands in
that agent's conversation as a message it can act on, and the agent writes back from the same
address. Titan's address on Jason's instance is `titan@titanium.bot`.

Mail comes in through Resend. The relay in front of the box takes the message, works out which
agent it belongs to, and hands it over as an ordinary prompt. Sending is the agent's own job: it
posts to Resend from its shell with a key you gave it once.

Nothing in the host bundle changed for any of this. The receiving side lives entirely in the relay
(`ui/mail-edge.mjs`), the way the job bus edge does.

---

## 1. What the operator does, once

You need a Resend account and a domain you control.

1. **Verify the domain in Resend.** Add the DNS records Resend shows you and wait for it to say
   verified. Until it is, sending fails with an unverified-domain error.
2. **Turn receiving on and add the MX record.** In Resend, enable inbound for the domain and add
   the MX record it shows you **at the apex** of the domain (`titanium.bot`, not `mail.titanium.bot`
   and not a subdomain). If you already use that domain for your own mail, do this on a domain or
   subdomain you are not reading mail on, because an MX record can only point one way.
3. **Create a webhook for `email.received`.** The address to paste is on the Email card in the
   console under Settings: it is `https://<your console>/hooks/resend`. Select only the
   `email.received` event.
4. **Copy the signing secret Resend shows you** (it starts with `whsec_`) and paste it into the
   card's "Webhook signing secret" field, then Save secret. Nothing is accepted without it.
5. **Create an API key in Resend** with send and read access, and paste it into the card's
   "Resend API key" field, then Save key. This is what reads the message back out of Resend after
   the webhook fires.
6. **Type your domain** into the card, pick who gets mail nobody else is named for, and Save.
   Turn **Receiving** on. Until you do, a signed message is answered and thrown away, which is
   what the card says on its own line.
7. **Give each agent the key so it can send.** In the agent's conversation, ask it to send an
   email; it asks for `RESEND_API_KEY` and you get a card to type the key into. The value lands in
   that agent's shell as an environment variable and never appears in the conversation. Agents with
   their own window get it through the same fan-out every other shell secret uses (ENV-1).

Both secrets are write-only. Once saved, no route on this server can read either one back: the
console shows "Saved" or "Not saved yet", and a Clear button.

---

## 2. Addresses

An agent's address is **its name, lower case, with the spaces taken out, at your domain**:

| Agent | Address |
|---|---|
| Titan | `titan@titanium.bot` |
| Chief of Staff | `chiefofstaff@titanium.bot` |
| Books | `books@titanium.bot` |

Renaming an agent changes its address. The card lists every agent's address so you can hand them
out.

A `+tag` is ignored, so `books+invoices@titanium.bot` is still Books.

### Who a message goes to

In this order, and the first one that answers wins:

1. **An agent whose name is the address.** Spaces and dashes do not count, so
   `chief-of-staff@` finds Chief of Staff.
2. **A route you wrote by hand**, from the settings' `routes` map (`billing` → an agent id).
3. **The catch-all agent** you picked on the card.
4. **The agent called Titan.**
5. **Nobody.** The message is recorded as `no_route` and left alone. It is never handed to
   whichever agent happens to be first on the roster.

When a message has several To addresses, the first one at your domain is the one it is routed on.

---

## 3. What an agent receives

One message in its conversation, in plain text:

```
Email received at books@titanium.bot
From: jane@client.example
Subject: September invoice
Date: 2026-09-06T21:00:00.000Z
Message-ID: <abc123@client.example>

Here is the invoice you asked for.

Attachments:
invoice.pdf (application/pdf, 18422) https://…/invoice.pdf (link expires 2026-09-07T21:00:00.000Z)

You can reply from your own address (books@titanium.bot); the email skill shows how, and a reply
must carry In-Reply-To: <abc123@client.example> so it threads.
```

The body is the message's text, or its HTML with the tags stripped when there is no text, capped at
20,000 characters. Attachments are listed and never downloaded by the relay; the agent fetches a
link only if it needs what is in the file.

The `email` skill on the box carries the send and reply recipes. It ships in the bundle
(`source/host/extensions/managed-setup/seed-skills/email/`), so an agent has it with no dashboard
login and no fetch.

---

## 4. The relay's routes

### `POST /hooks/resend`

Public: no session and no bearer, because this is Resend calling. Its credential is the Svix
signature on the body.

- Bodies over 256 KB are refused with 413. 60 requests a minute per address; past that, 429.
- With no signing secret stored: `503 {"error":"not_configured"}`.
- The signature is verified by hand with `node:crypto`, no dependency: the signed content is
  `svix-id + "." + svix-timestamp + "." + the raw body`, the key is the base64 bytes of the secret
  after `whsec_`, and the expected value is the base64 of the HMAC-SHA256. The `svix-signature`
  header is space-separated `v1,<base64>` entries and any one of them may match. The timestamp has
  to be within five minutes. A bad or missing signature is `401 {"error":"invalid_signature"}`.
- **Everything past the signature answers 200**, so Resend never retries for hours over a decision
  we made on purpose:
  - receiving is switched off on the card → `{"ignored":"disabled"}`
  - not an `email.received` event → `{"ignored":"type"}`
  - an `email_id` already in the ledger → `{"ignored":"duplicate"}`
  - Resend would not answer → `{"ignored":"fetch_failed"}` (logged)
  - nobody to give it to → `{"ignored":"no_route"}`
  - the gateway refused the prompt → `{"ignored":"send_failed"}` (logged)
  - delivered → `{"delivered":{"agentId":"…","agentName":"…"}}`
- The message is read with `GET {apiBase}/emails/receiving/{email_id}` and its attachments with
  `…/attachments`, both with the stored key and a 15 second timeout. Every field on the answer is
  treated as optional.
- Delivery is one gateway `sendPrompt {agentId, prompt, clientNonce: "mail:<email_id>"}`. The
  gateway bearer never leaves the relay.

### `GET /mail/settings`

Behind the console session (or the relay bearer), like every other console route. Answers:

```json
{ "enabled": false, "domain": "titanium.bot", "fromName": "Titanium Bot", "apiBase": "",
  "catchAllAgentId": "", "routes": {}, "apiKeySet": true, "webhookSecretSet": true,
  "webhookUrl": "https://console.titanium.bot/hooks/resend",
  "addresses": [{ "agentId": "…", "name": "Titan", "address": "titan@titanium.bot" }],
  "recent": [ … the last 20 ledger rows, newest first … ] }
```

Neither secret is ever in this shape. `apiKeySet` and `webhookSecretSet` are the whole answer about
them.

### `POST /mail/settings`

A partial update, answering the same shape. `enabled`, `domain`, `fromName`, `apiBase`,
`catchAllAgentId` and `routes` are replaced when present. `apiKey` and `webhookSecret` are **set**
when a string, **cleared** when `null`, and **kept** when the field is absent, which is what lets
the card save the rest of the form without ever holding a secret.

---

## 5. The files the relay writes

| File | What it holds |
|---|---|
| `ui/mail.json` | The settings, including both secrets. Mode 0600, owned like its directory, gitignored. |
| `ui/mail-inbox.jsonl` | One line per event: `{at, email_id, message_id, from, to, subject, agentId, agentName, outcome}`. Mode 0600, gitignored. |

The ledger is the "what arrived and where it went" record the console shows, and the duplicate
check reads it. **It never holds a body or a secret.** It is not an archive of your mail; Resend has
that.

`outcome` is one of `delivered`, `no_route`, `fetch_failed`, `send_failed`. An event that was not
received mail, a message that arrived while receiving was switched off, and a duplicate that
already has a row, do not write one.

---

## 6. Sending

There is no email tool. An agent sends through its shell:

```bash
curl -sS -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"Books <books@titanium.bot>","to":["jane@client.example"],
       "subject":"Re: September invoice",
       "headers":{"In-Reply-To":"<abc123@client.example>"},
       "text":"Thanks Jane, that is received."}'
```

`In-Reply-To` carrying the Message-ID of the mail it is answering is what puts the reply in the
same thread. The skill says so, and says never to paste the key into a message.

---

## 7. The gate

```
node scripts/verify-mail.mjs --url http://127.0.0.1:7777 --stub
node scripts/verify-mail.mjs --url https://console.titanium.bot
```

With `--stub` the gate starts a small HTTP server of its own serving one synthetic received email
and one attachment list, points `apiBase` at it, and measures: the unconfigured hook answers 503, a
signed `email.received` to the first agent's address is delivered and its ledger row appears in
`GET /mail/settings.recent`, a forged signature is 401, a signature older than the window is 401, a
replayed `email_id` is a duplicate, a signed message arriving while Receiving is off is not taken
in, the GET never returns a secret, and the settings are put back with both secrets cleared even
when a leg fails. 35 PASS on a relay copy on this Mac.

Without `--stub` only the non-mutating legs run, so a production relay that is already configured
is never overwritten.

The off-box half is `tests/mail-edge.test.mjs` in `npm test`: the signature and its timestamp
window, the routing order, the prompt text, the ledger row shape, and the fact that no shape this
module answers with can carry a secret.

---

## 8. What this does not do

- **No outbound record.** The relay sees mail coming in, not going out. What an agent sent is in
  its own conversation and in Resend's dashboard.
- **No threading on the way in.** Each message is its own prompt. An agent that wants the history
  reads its own conversation.
- **One domain.** The settings carry one, which is the operator's own.
- **Attachments are links, not files.** The relay never downloads one, and the links Resend hands
  over expire.
