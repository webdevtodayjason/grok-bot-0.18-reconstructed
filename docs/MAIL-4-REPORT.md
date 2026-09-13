# MAIL-4: a bot's mail takes several people, a cc and a bcc

**The fault, in the bot's own words.** Titan's feedback row, 2026-09-10 02:16Z, tenant `titanium`:
*"MAIL-3 outbound works (sends accepted cleanly from agent addresses), but the send path supports
exactly one recipient per message: no CC field, no BCC."* It was right, and it was deliberate at the
time: one row was one mail so that the cap arithmetic, the log row and the line on the person's screen
each meant one thing. MAIL-3i filed the limit.

Branch `night-mail4` off `e4e8455`. Measured on this Mac, node v22.23.1. Nothing was sent through
`api.resend.com`, nothing ran on a box, and the R750 was not touched.

---

## 1. What the send path was, read end to end before anything was written

| hop | file | what it did with the recipient |
| --- | --- | --- |
| the bot's tool | `source/host/runner/tools/send-email-tool.ts` | `to: z.string()`, described as "The one person this goes to … never put a list in this field". Its outline args carried that one string, which is the chip the person reads. |
| the box's hop | `source/host/extensions/mail/relay-send-client.ts` | `RelaySendRequest.to: string`. Posts `{agentId, to, subject, text, html?, inReplyTo?, idempotencyKey}` to `<relay>/mail/send` with the box's gateway bearer. |
| the relay | `ui/mail-edge.mjs` `createMailSendRoute` | `oneAddress(body.to)` against `/^[^\s@,<>"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/` — a regex that excludes a comma, so a list in one string was already refused. An array was refused too, as "not an address". Sent Resend `to: [to]` and no `cc` or `bcc` at all. |
| the claim | `cp/mail.mjs` `openSend` → `cp/store.mjs` `claimMailSend` | one `mail_send_log` row per mail, `to_addr TEXT`, caps counted per ROW. |
| the records | `ui/mail-sent.jsonl` via `mailSentLedgerRow`, and the relay's log line | one `to` string each. |
| the screens | the workspace's Email card (Sent table) draws `row.to`; the conversation chip draws the tool's one args string | one address each. |

Two things in that list decided the shape of this wave. The control plane's row is **one TEXT column**
for the recipient, and the Mail card draws **that one column and nothing else** from a sent row.

## 2. What it does now

- **`to` takes one address or a list; `cc` and `bcc` are lists beside it.** Absent or empty is nobody,
  and only an empty `to` refuses.
- **A string is still exactly one address.** A comma inside one is refused, not split: every box in
  the fleet has been sending `"to": "jane@client.example"` since MAIL-3 and a relay swapped under them
  must not read that differently. The box's tool is where a person's comma-separated line is split.
- **One rule for every address.** `sendRecipients(value, field)` runs the single recipient's
  `oneAddress` over every entry of every field, so `cc` cannot accept what `to` refuses.
- **A bad address anywhere refuses the whole mail and names the field**: *"One of the Cc addresses is
  not a plain email address, so nothing was sent."* Nothing is claimed and Resend is not called.
- **Twenty addresses across the three fields**, counted after duplicates come out. One row is still
  one mail, so the ceiling is what bounds how far one claimed row may be amplified. A twenty-first
  refuses with the count it saw and the 20.
- **An address in two fields is one copy**, the first field keeping it, compared case-insensitively
  and sent exactly as typed.
- **Resend gets `to`, `cc` and `bcc` as its own three fields**, each omitted when empty. A copy is
  never folded into `to`.
- **Every recipient is on every record.** The control plane's row, the workspace's own sent ledger and
  the relay's log line all carry `jane@client.example, bob@client.example, cc: book@client.example,
  bcc: audit@titaniumcomputing.com`. A bcc is hidden from the other recipients and from nobody else.
- **The old single-recipient send is byte for byte what it was**: the same answer sentence, the same
  `res.body.to`, the same Resend payload, the same ten keys on the ledger row, the same claim shape.

### The two strings, deliberately different

The **row in the conversation** names two addresses and counts the rest — *Sent an email to
jane@client.example, bob@client.example and 2 more* — because it is one muted line with nothing to
expand, read on a phone as often as a desktop. The **sentence the model reads back** names every one,
copies included, in words: *Sent to jane@client.example, bob@client.example, copying
book@client.example, blind copying audit@titaniumcomputing.com from agent247758@myagents.email.*

### What was NOT touched, and why

`cp/mail.mjs` and `cp/store.mjs` are unchanged. The claim's argument shape is the same five keys it
was, with every recipient travelling in the `to` string that table's one column already holds. Three
nullable columns and an `ALTER` would have been a migration for a question the one column answers:
who did that bot write to. `ui/machine-room/app.js` is unchanged too, which is why `to` on a sent row
is the whole readable recipient line and `cc`/`bcc` repeat it as their own fields: the card draws that
column, and a `to` naming one of four people would be the console under-reporting mail that left in
the customer's name. Those two extra fields appear only when there is something in them, so a row
written before this wave and a single-recipient row written after it are the same shape.

`POST /mail/product` (the welcome) still refuses `cc`, `bcc` and an array `to` **by name**, untouched:
a product mail carries a live sign-in link, so a second recipient is a second key to somebody's
workspace.

## 3. Files

| file | change |
| --- | --- |
| `ui/mail-edge.mjs` | `MAIL_SEND_RECIPIENTS_MAX`, `sendRecipients`, `sendRecipientSet`, `recipientSummary`, `recipientWords`; the route validates the three fields, passes them to Resend, and writes the summary to the claim, the ledger and the log; `mailSentLedgerRow` takes `cc` and `bcc`. |
| `source/host/extensions/mail/relay-send-client.ts` | `to: string \| readonly string[]`, optional `cc` and `bcc`, and the contract comment says so. |
| `source/host/runner/tools/send-email-tool.ts` | `cc` and `bcc` parameters; `sendEmailAddresses`, `sendEmailRecipientChip`, `sendEmailRecipientWords`; the hint and the description. |
| `source/host/extensions/managed-setup/seed-skills/email/SKILL.md` | the Sending section: several people, the two kinds of copy, the twenty, a cc is a recipient. |
| `source/host/extensions/managed-setup/seed-skills/handbook-what-i-can-do/SKILL.md` | the Email row no longer says "One person per message, no copies". |
| `source/host/extensions/managed-setup/seed-skills.gen.ts` | regenerated with `node scripts/gen-seed-skills.mjs`. |
| `docs/MAIL.md` | the header banner, §5's ledger row, §6's request shape, the refusal order, the caps, the log row, Recipients, the new "Several people, and copies" and "What the bot's own tool takes" sections, §8, and the measured §9c. |
| `tests/mail-send-route.test.mjs` | 9 new cases; the old "a list is refused" line replaced by the new truth, the comma-in-one-string case kept. |
| `tests/send-email-tool.test.mjs` | 5 new cases; `cc`/`bcc` off the forbidden-parameter list, `from` and `reply_to` still on it. |

## 4. Measured

| gate | result |
| --- | --- |
| `node --test tests/mail-send-route.test.mjs` | **32 PASS, 0 FAIL** |
| `node --test tests/send-email-tool.test.mjs` | **28 PASS, 0 FAIL** |
| the mail, onboarding, product-mail and chip suites together (14 files) | **296 PASS, 0 FAIL** |
| `node --test tests/*.test.mjs` | **3365 of 3366 PASS** |
| `tsc --project source/tsconfig.json` | clean |
| `node --check ui/mail-edge.mjs` and both changed suites | clean |

The tests asked for by the row, and where each one is:

| asked for | test |
| --- | --- |
| single `to` unchanged | "MAIL-4: one recipient is byte for byte the send MAIL-3 made" |
| a list `to` | "a list in to reaches Resend as a list, and it is still one claim and one ledger row" |
| cc and bcc in the right Resend fields | "cc and bcc reach Resend in their own fields and nowhere else" |
| an invalid address anywhere refuses the whole send with the field named | "one bad address anywhere refuses the whole send, names the field, and sends nothing" (7 shapes) |
| more than 20 refuses | "more than twenty people refuses, naming the number, before anything is claimed" |

## 5. One consequence left alone on purpose

`node cp/cli.mjs mail sends <slug>` pads the recipient cell to 32 characters with `padEnd`, which does
not truncate, so a row naming four people pushes that row's outcome, Resend id and bot name to the
right of the header. The cell is complete and readable and the table is not. Truncating it would line
the columns up by hiding recipients from the one view an operator uses to answer "did that bot email
them", which is the wrong trade, so the misalignment stays. `GET /v1/mail/sends` and the customer's own
Sent table both carry the whole line.

## 6. What is not proven

- **No real Resend send.** Nothing in this wave touched `api.resend.com`. The payload Resend would
  receive is asserted against the shipped route with a recording `fetch`, and that is all.
- **No box ran the tool.** The comma split is proved in the tool's own suite, not in a model's turn.
  `scripts/verify-mail.mjs --send-box` is the leg that would, and it is a model turn: slow and not
  deterministic.
- **`scripts/verify-mail.mjs --send` was not run.** Its nineteen legs are all single-recipient, so cc
  and bcc over a real socket to a stub Resend is unmeasured. Filed as **MAIL-4c** in docs/MAIL.md §8
  with the leg to add.
- **An incoming mail still does not say who else was on it.** The receive path reads `received_for`,
  `data.to` and `message.to` and no `cc`, and `mailPrompt` prints no recipient list, so a bot cc'd on
  a thread answers as though it were alone and cannot attempt a reply-to-all. Pre-existing, outside
  this row's send path, filed as **MAIL-4b** in docs/MAIL.md §8 with the next action and the proof.
- **One pre-existing suite failure, not mine and not mail.**
  `tests/publication-packaging.test.mjs`, "Router settings use the trusted backend and display
  recorded inference usage", asserts `source/host/extensions/inference/inference-service.ts` matches
  `/createProviderPromptSession\(provider\)/` and it does not. None of this wave's nine files is read
  by that test and none of the files it reads is in this branch's diff. It needs an owner in the
  inference plane; fixing it here would mean editing `source/host/extensions/inference/` and
  `source/electron-main/`, which is another worker's slice tonight.
- **docs/GAP-ANALYSIS.md was not edited.** Its **MAIL-3i** row ("A send takes one recipient. No cc, no
  bcc, no arrays") is closed by this wave and still reads as open and owned. That file is being edited
  concurrently in the main tree, so the row is left to whoever merges this: mark MAIL-3i **CLOSED by
  MAIL-4, 2026-09-13**, one row per mail with up to twenty recipients, and keep MAIL-3e (bounces)
  open, since a bounce is still invisible and now invisible for twenty people at once.
