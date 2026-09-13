# Mail to the support address

**Status:** built by SUPPORT-1, 2026-09-13, overnight batch of 2026-09-12. This file is the
contract: every name below is binding, and that includes the payload's field names, the setting
names, the relay route, the three states and the words a person reads on the panel.

Jason, 2026-09-12: *"Support@titaniumbot. If something comes in on that, I know we're able to
receive mail. We've got to do something with that so maybe that goes to a new support page and
sends me a notification to my Titanium."*

**What was there before.** A Cloudflare Email Routing rule forwarding `support@titanium.bot` to
Jason's personal mailbox, and nothing else. No record on the product, nothing Richard or anybody
else on the team could open, and no way at all to tell a message that was answered from one that
was missed in a busy week.

---

## 1. The three pieces, and why the seam is where it is

| | what it is | who deploys it |
|---|---|---|
| the **email worker** | a Cloudflare Email Worker on the `titanium.bot` zone. It parses the message, POSTs it here, and still forwards it to the mailbox | **the operator.** Section 6 is its code. This repository does not deploy it and does not hold its credential |
| the **intake** | `POST /v1/relay/support` on the control plane, behind a bearer this service minted | shipped |
| the **panel** | Support, the tenth entry on the admin console's rail, plus one notification into the operator's own workspace | shipped |

**The seam between the first two is a credential boundary and not a preference.** A Cloudflare
Worker is code running in somebody else's datacentre with a secret in its environment.
`CP_RELAY_TOKEN` opens `GET /v1/relay/tenants`, which is the one route on this service that answers
with **every customer's gateway token and every customer's derived session key**, so a Worker
holding it would be one leaked environment away from the whole fleet. It holds `support.inboundToken`
instead, which opens exactly one route and nothing else. That is the whole reason this feature has a
setting of its own rather than reusing the credential that was already there.

The path still sits under `/v1/relay/` because what it carries is forwarded inbound traffic. **The
prefix is a description of the traffic and has never been a credential**, which is why
`cp/server.mjs` writes that down in a comment over the route: the next person to read the
dispatcher will otherwise assume the band is uniform and it is not.

**The forward is kept.** The Worker calls `message.forward()` as well as POSTing, so Jason's mailbox
goes on receiving exactly what it received before. A control plane that is down or mid-redeploy then
costs a row on a panel and never a customer's question.

---

## 2. The one thing this does not do: reply

There is no Reply button and there is no outbound send anywhere in this feature. Two reasons, and
either on its own settles it:

- **There is nothing to send from.** The product's bot mail goes out as `agent<code>@myagents.email`
  through the relay's own key, with the From decided by the relay and deliberately not by its caller
  (`docs/MAIL.md` §6). A support reply is not a bot's mail, it has no bot, and a reply that arrived
  from a robot address a customer cannot write back to is worse than no reply.
- **There is no thread.** Nothing here holds the `References` and `In-Reply-To` chain, so a send
  from this panel would land as a new conversation in the customer's inbox, detached from the
  question they asked.

So the panel prints *"Nothing is ever sent from here"* under its own heading, the operator answers
from their own mail client, and **`replied` is the operator's record that they did it** rather than
an action that did it. A button wired to nothing is the failure class this product already has a
rule about.

---

## 3. The row, and the three states

`support_messages` in `cp/store.mjs`. **Not a tenant table**: a support message comes from a stranger
and belongs to the operator, so there is no tenant column to stamp and nothing is scoped per
customer. That is the whole difference from `feedback`, whose rows arrive through a workspace's own
console and carry the slug the relay stamped.

| column | what it holds |
|---|---|
| `received_at` | when the sending side stamped it, as the Worker reported it. Not when this service saw it |
| `from_addr`, `to_addr` | the addresses, taken out of the angle brackets. `from_addr` and not `from` because both words are reserved in SQL and the first statement that forgot to quote one would be a syntax error at run time rather than at review. `mail_send_log` already spells its recipient `to_addr` for the same reason |
| `subject` | one line, clamped |
| `text` | the plain part |
| `html_text` | the html part **flattened to its words**, beside the plain text and never instead of it |
| `message_id` | the sender's own `Message-ID`, or a derived one. **UNIQUE** |
| `state` | `new`, `replied`, `closed` |
| `notes` | the operator's own note. Nothing the sender wrote is ever editable |
| `notified_at`, `notify_detail` | **a receipt and not a plan.** Whether the operator's workspace was actually told, and the sentence saying why it was not |
| `decided_at`, `decided_by` | who moved the state last |

**Three states and there is no fourth.** `new` it arrived and nobody has answered it. `replied`
somebody wrote back from their own mail client. `closed` it is dealt with, which covers an answered
question and a piece of spam equally. There is deliberately no `suppressed`: the feedback table has
one because "we decided this was not a bug" is a record worth keeping apart from "we fixed it", and a
stranger's email has no such distinction. It is open or it is done.

**`message_id` is UNIQUE and that is what makes a retrying Worker safe.** Cloudflare retries a
Worker that threw or timed out, and a second delivery of the same message must be one row and one
notification rather than two. A message whose sender sent no `Message-ID` header at all -- and a
surprising number of automated senders send none -- is given a derived one,
`derived-<40 hex characters>`, hashed over the sender, the subject, the stamped time and the body.
Those are exactly the parts that are identical on a retry and different between two messages from
the same sender in the same second. It is a digest rather than the values themselves, so nothing a
stranger wrote ends up inside an index a developer later greps.

**Never pruned**, the same as `admin_actions` and `feedback` and for the same reason: "has this
person ever written to us before" is a question asked months later, and the rows are a few kilobytes
each on a system where a support mail is a rare event.

---

## 4. The notification: which path, and why that one

**The path: one `sendPrompt` into the operator's own workspace, through that box's gateway, using
the gateway token this control plane already holds on disk.** Plus one `listAgents` read to find
which bot to tell, which is free. The line is exactly:

```
Support mail from <the sender's address>: <the subject>
```

One line, and one line for a reason that is money: a prompt is a **model turn in the operator's own
workspace**, so a paragraph of quoted mail would be a paragraph of tokens on every message that
arrives. The sender and the subject are what decide whether somebody opens the panel now or later,
and the panel is where the message itself is.

**This is not a new mechanism.** `cp/onboard.mjs` already reaches a customer's box this way for its
two reads: `http://titanbot-box-<uuid>:1340/api/<command>` on the docker bridge, with the token from
`readGatewayToken`, which is why the control plane is on `titanbot-net` at all. `cp/support.mjs`
copies that call and its one override (`CP_BOX_URL_OVERRIDE`, for a gate that cannot resolve a
container name, never set on the R750) and adds nothing.

### Why not the other three paths

Each of these was read in the live code before the one above was chosen.

- **A push to the phone app.** `GET /push/pending` and `GET /push/events` are decided **by the
  relay**, off the cards it reads out of a box's own roster and transcript tails (`docs/APPS.md`
  §15). There is no route anywhere that lets another service raise a notification, and adding one
  means a new relay door plus a new card kind in `ui/push-edge.mjs`. That is the right long-term
  home and it is a wave of its own, not a line in this one.
- **A product email to Jason.** `POST /mail/product` on the relay exists and the control plane
  already calls it for the welcome mail. It refuses any `kind` that is not `welcome`
  (`ui/mail-edge.mjs` `PRODUCT_MAIL_KINDS`), so this would need one new kind in a file another wave
  holds. It is also the weakest of the options on its own terms: the thing Jason already had was a
  mail in his mailbox, and a second mail about a mail is not a notification, it is noise.
- **A gateway command that costs no turn.** There is none that carries words.
  `appendConnectorCard` takes a connector name and a variant rather than text; `setAgentUnread`
  raises a badge with nothing behind it, which is a notification that tells somebody to go and look
  at nothing. A badge with no message is worse than the panel on its own.

### What it costs, plainly

**One model turn per support message that arrives, in the operator's own workspace.** Nothing else:
the roster read costs no tokens, a retried delivery costs nothing at all, and a workspace whose box
is unreachable costs one failed HTTP call. At the volume a support address sees, that is cents a
month, and it is the only spend this feature has.

`support.notify` set to `0` turns the prompt off entirely. The panel then still lists everything and
the panel's note says announcing is off, rather than quietly looking the same as a working one.

### Who gets told, and which bot

| setting | default when it is empty |
|---|---|
| `support.notifyWorkspace` | **the workspace the first enabled super admin account signs in to.** Derived rather than hardcoded, because "my Titanium" names this install's own operator workspace and a slug compiled into the product would be wrong on every other install of it |
| `support.notifyAgent` | **the bot called Titan** on that box's own roster, read with one `listAgents`. Naming an agent id here skips the roster read |

A control plane with no super admin account has nobody to tell, and the panel says that sentence
rather than going quiet. A `support.notifyWorkspace` naming a workspace that does not exist says
that too.

`listAgents` answers a **bare array** on some host builds and `{agents: [...]}` on others. Both are
read. That exact disagreement is what made a PUSH-1 sweep report a clean zero on a box with twelve
bots, and it is pinned in the suite here for the same reason.

**A notification never blocks a message.** A box that cannot be reached, a roster that cannot be
read or an announcing switch that is off all leave the message **stored** and answer `201` with
`notified: false` and the reason. A 500 there would have Cloudflare retry a delivery that already
succeeded, and the message would be announced at the next one anyway. The reason is written onto the
row, and the panel draws a message nobody was told about in red: a notification that silently failed
for a fortnight must not look like one that worked every time.

---

## 5. The routes

### `POST /v1/relay/support`

The Worker's delivery. The credential is `support.inboundToken`, presented as
`Authorization: Bearer <token>`, and **`CP_ADMIN_TOKEN` and `CP_RELAY_TOKEN` both answer 401 here.**

The body, and every name in it is binding:

```json
{
  "from": "Jane Doe <jane@example.com>",
  "to": "support@titanium.bot",
  "subject": "My bots stopped answering this morning",
  "text": "Three of them are quiet since about eight.",
  "html": "<p>Three of them are quiet since about eight.</p>",
  "messageId": "<abc123@mail.example.com>",
  "receivedAt": "2026-09-12T08:14:00.000Z"
}
```

`from` is the only required field, plus at least one of `text` and `html`. `receivedAt` takes an ISO
string or a number of milliseconds, and falls back to now. An unknown key is **not an error and is
not stored**: a support message is a record of what arrived, not a document somebody gets to design.
Nothing takes a `state`, a note or an id from a body.

The limits, all of them inside the 64 KB this service reads a request body at
(`cp/server.mjs MAX_BODY_BYTES`), so a Worker that clips to them always lands:

| field | at most |
|---|---|
| `from`, `to` | 320 characters, clamped |
| `subject` | 500 characters, one line, clamped |
| `text` | 32,768 characters, **refused** over |
| `html` | 65,536 characters, **refused** over |
| the flattened html that is stored | 16,384 characters, clamped |
| `messageId` | 250 characters, clamped |

**A field over its limit is refused and never cut down**, the rule `cp/feedback.mjs` established: a
message silently truncated reads as a whole one, and the person answering it answers half a question
without knowing there was more. The one-liners are the exception and are clamped, because a 9 KB
`Subject` header is a malformed mail rather than evidence and refusing it would drop a real
customer's question over the shape of its header.

**Every refusal names the field**, because the reader of a 400 here is the operator looking at their
own Worker:

| what happened | answer |
|---|---|
| wrong method | `405` |
| no `support.inboundToken` minted yet | `503 {"error": "not_configured"}` and the sentence says where to mint one. **Not a 401**: there is nothing wrong with the caller, and saying so is the difference between a ten minute fix and an hour of reading Worker logs |
| no bearer, a wrong one, the admin token or the relay token | `401 {"error": "unauthorized"}` |
| a body that is not a JSON object | `400 {"error": "bad_request", "field": "body"}` |
| no `from` | `400 … "field": "from"` |
| no `text` and no `html`, or html with no words in it | `400 … "field": "text"` or `"html"` |
| `text` or `html` over its limit | `400 … "field": "text"` or `"html"`, with the number and *"Clip it in the worker."* |
| a body over 64 KB on the wire | `400 {"error": "too_large"}`, from the body reader |
| **stored, and the workspace told** | `201 {"id", "state": "new", "duplicate": false, "notified": true, "notifyWhy": ""}` |
| **stored, and nobody could be told** | `201 … "notified": false, "notifyWhy": "<the reason>"` |
| **already here** | `200 … "duplicate": true`. Nothing is stored again and nothing is announced again |

**The duplicate answers 200 rather than 409 on purpose.** A Worker that sees anything but a 2xx tries
again, and this delivery has in fact already succeeded.

### `GET /v1/admin/support`

The panel's read, behind the super admin guard like everything under that prefix. `?state=` filters,
`?since=` takes an ISO string or milliseconds, `?limit=` defaults to 200 and caps at 2,000. Newest
first, filtered in sqlite rather than in this process.

**The counts are over everything and not over the filtered list**, the shape the Feedback panel uses
and for the same reason: the number an operator needs is how many are unanswered, and a filter is
exactly what hides that.

The answer also carries `token` (presence and evidence, never a value), `notify` (whether announcing
is on, which workspace, and why not when it is nobody), `gates` (the sentence the panel prints), and
`measuredAt`.

### `POST /v1/admin/support/<id>/state`

`{"state": "new" | "replied" | "closed", "notes": "optional"}`. A fourth state is
`400 {"field": "state"}` and moves nothing. An id that is not a row is `404`. Every move writes an
`admin_actions` ledger row (`support.replied`, `support.closed`, `support.new`) with who, when and
from where, the same as every other action on that console. A note is kept when a later move does
not carry one.

`replied` answers with the sentence *"Nothing was sent from here: this is your own record that you
answered it from your mail client."* An operator who thinks pressing a button answered a customer is
a customer who never hears back.

### `POST /v1/admin/support/token`

Mints the bearer, stores it, **answers it once** and writes it nowhere else. Minting replaces
whatever was held, so a Worker still holding the old one stops being able to deliver the moment this
is pressed. That is a rotation and the panel says so before the button is pressed.

It is minted rather than typed for the reason a password is: a secret handed to a CLI as an argument
is in a shell history file, and a secret somebody invents is as good as the afternoon they invented
it. The name is still the ordinary setting `support.inboundToken`, in `SECRET_SETTINGS`, so
`listSettings` answers the name and never the value and nothing else on this service can read it
back.

> **`node cp/cli.mjs setting set` cannot write this name.** That verb carries a two-name allowlist
> (`allowance.levels`, `spend.prices`) in both `cp/cli.mjs` and the admin settings route, and this
> wave owned neither file. Minting from the panel is the better shape anyway, for the shell-history
> reason above, so the CLI verb is filed as **SUPPORT-1b** rather than built: one name in each
> allowlist if anybody ever wants it.

---

## 6. The Cloudflare Email Worker, which the operator deploys

**This repository does not deploy this and has never run it.** It is the one piece of SUPPORT-1 that
lives in Jason's Cloudflare account, and until it is deployed the intake is live, the panel is live
and no message has ever arrived through either.

### What it does, in order

1. Cloudflare Email Routing hands the Worker the message, because the routing rule for
   `support@titanium.bot` is changed from **Send to an address** to **Send to a Worker**.
2. The Worker **forwards it to the mailbox first**, so the thing Jason has today keeps working
   whatever happens next. The destination address has to be a verified one in Email Routing, which
   it already is: it is the address the current forward points at.
3. It parses the MIME with `postal-mime`, clips every field to the limits in section 5, and POSTs
   one JSON body to `https://api.titanium.bot/v1/relay/support` with the bearer.
4. **A 5xx throws and a 4xx does not.** Throwing is what makes Cloudflare retry, which is right when
   the control plane is restarting and wrong when the body will never be accepted: a 400 retried for
   six hours is six hours of a queue moving nothing. A 4xx is logged and swallowed, and the mail is
   already in the mailbox either way.

### The steps

```
# once, in the worker's directory
npm install postal-mime
npx wrangler secret put SUPPORT_TOKEN     # paste the value from the console's Support panel
npx wrangler deploy
```

Then in the Cloudflare dashboard, on the `titanium.bot` zone, under **Email** then **Email
Routing** then **Routing rules**: change the rule for `support@titanium.bot` from *Send to an
address* to *Send to a Worker*, and pick this Worker. `FORWARD_TO` in the Worker's `wrangler.toml`
`[vars]` is the address it keeps forwarding to.

### The Worker

```js
// support-intake worker -- Cloudflare Email Routing -> api.titanium.bot
// Secret:  SUPPORT_TOKEN  (minted on the admin console's Support panel, shown once)
// Vars:    FORWARD_TO     (the mailbox this used to forward to)
//          INTAKE_URL     (default https://api.titanium.bot/v1/relay/support)
import PostalMime from "postal-mime";

// The control plane's own limits, from docs/SUPPORT.md section 5. A field over one of these is
// refused with the field named rather than truncated, so the clipping happens here on purpose.
const MAX = { from: 320, to: 320, subject: 500, text: 32 * 1024, html: 64 * 1024, messageId: 250 };
const clip = (value, limit) => String(value ?? "").slice(0, limit);

export default {
  async email(message, env, ctx) {
    // THE FORWARD FIRST, always. Whatever happens to the POST below, the mailbox gets the mail it
    // would have got before this worker existed.
    if (env.FORWARD_TO) {
      try { await message.forward(env.FORWARD_TO); }
      catch (error) { console.log(`forward failed: ${error?.message ?? error}`); }
    }

    const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
    const body = {
      // The display From, which is what a person reads, with the envelope sender as the fallback.
      from: clip(parsed.from?.address || message.from, MAX.from),
      to: clip(parsed.to?.[0]?.address || message.to, MAX.to),
      subject: clip(parsed.subject, MAX.subject),
      text: clip(parsed.text, MAX.text),
      html: clip(parsed.html, MAX.html),
      messageId: clip(parsed.messageId || message.headers.get("message-id"), MAX.messageId),
      receivedAt: (parsed.date ? new Date(parsed.date) : new Date()).toISOString(),
    };

    const answer = await fetch(env.INTAKE_URL ?? "https://api.titanium.bot/v1/relay/support", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SUPPORT_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (answer.ok) return;
    const said = (await answer.text()).slice(0, 300);
    // A 5xx is ours and is worth another try; a 4xx will never be accepted, so retrying it for hours
    // moves nothing. The mail is in the mailbox either way.
    if (answer.status >= 500) throw new Error(`support intake answered ${answer.status}: ${said}`);
    console.log(`support intake refused it (${answer.status}): ${said}`);
  },
};
```

### Why a parser at all

`message.raw` is the whole MIME document. Storing that verbatim would put base64 attachment blocks
and quoted-printable escapes in front of whoever reads the panel, which is the message hidden rather
than shown. `postal-mime` is the parser Cloudflare's own Email Workers documentation uses for this,
it runs in the Workers runtime with no node shims, and it is the only dependency here.

### What it does not do

No attachments. The intake takes none, stores none and has no field for one, so a support mail with a
screenshot on it arrives as its words and the operator opens the copy in their own mailbox for the
picture. An attachment is the one piece of a message nobody has checked before it is stored, which is
the same custody argument that left the feedback card without a screenshot field (FEEDBACK-1d), and
it is filed the same way: **SUPPORT-1c**, a deliberate no until somebody wants it enough to do the
custody work.

---

## 7. The Support panel

Tenth on the rail, between Feedback and Marketplace. One card per message, newest first.

- The **head** is the subject, the sender, a state chip and how long ago it arrived.
- Under it, **whether the workspace was actually told**, in grey when it was and **red when it was
  not**, with the reason. A message that is on the screen and was never announced has to be visible
  rather than inferred.
- The **body on click**, behind a `details` element, because the panel is a list of who is waiting
  and the text is what you open when you decide to answer one. The summary says how many words, and
  says when they came from the html part rather than a plain one.
- A **note** field and the **state buttons**: Mark replied and Close on an open message, and Reopen
  as well on one that has been moved. The note travels with whichever button is pressed.
- At the foot, **the mint form** for the inbound token. There is no token FIELD on this panel and
  there never will be: the value is minted by this service and shown once, so a text input for it
  would be a place to paste a credential nothing reads.

**Every field on a card was written by a stranger** -- anybody on the internet can write to a support
address -- so every one reaches the page through `textContent` and not one of them is ever assigned
to `innerHTML`. The html part arrives already flattened to words by `cp/support.mjs`, whose
flattener drops a `script` or `style` block's contents rather than letting a page of CSS through as
text. That flattener **is not a sanitizer and is not claimed to be one**: nothing in this product
ever renders the string as markup, so the safety is in the renderer.

The Overview chip is **Support unanswered**. It reads red rather than green when no inbound token has
been minted, because a zero with nothing able to deliver is not good news and the chip has to say
which of the two it is looking at.

The console is now **eleven panels and nine loaders**, and they are different numbers on purpose: the
Overview is drawn from a registry the loaders write to and Keys is drawn by the System health loader.
`window.__adminLive.panels` counts loaders and reads `9`.

---

## 8. What is measured, and what is not (updated 2026-09-13 00:50 CDT)

Measured on the R750 and on Cloudflare the same night the intake shipped:

- **The Email Worker runs.** `support-intake` was deployed from the code block in section 6 on
  2026-09-13 at 00:22 CDT (versions c391a903, then a178dd71 with logs on), its `SUPPORT_TOKEN`
  set by a pipe from the control plane's mint route so the value never crossed a terminal, and the
  Email Routing rule for `support@titanium.bot` switched from a forward to Send to a Worker at
  00:24 CDT. The forward to the mailbox is kept inside the worker.
- **The intake is live on the R750.** The control plane was recreated with this code at 00:19 CDT;
  `POST /v1/relay/support` answers 401 to a bad bearer from the internet and 200 to the worker.
- **Five test mails arrived** (from `farm@tiinyapp.farm` through Resend, each "delivered" on Resend's
  side). Rows 1 to 3 landed in the Support panel with "nobody was told": the titanium workspace,
  the one adopted rather than provisioned, had no `box_container` on its row and no profile token
  file. Both were written on the R750 (the token copied from the box's own environment, never
  through a session). Row 4 then logged `Titan in titanium was told`.
- **Open on the panel:** the five test rows sit in state `new` for the operator to close.

Still not proven:

- What the notification looks like inside Titan's conversation for a person (the turn ran; nobody
  has read it on the console yet).
- An adopted tenant no longer needs its row filled by hand: since SUPPORT-1d (2026-09-13, cp/provision.mjs
  `boxContainerFor`, `tenant adopt --gateway-token-stdin`) the container name derives from the Coolify
  uuid and the token file is written at adopt time. See docs/TENANCY.md section 10.

## 9. Where everything is

| | |
|---|---|
| the intake's checks, the desk, the notification | `cp/support.mjs` |
| the table, the states and the row | `cp/store.mjs` (`support_messages`, `SUPPORT_STATES`, `SUPPORT_FIELD_LIMIT`) |
| the relay route | `cp/server.mjs`, one block beside the feedback intake |
| the panel's three routes | `cp/admin.mjs`, one block at the foot of the dispatcher |
| the panel | `cp/admin/index.html`, `cp/admin/admin.js`, `cp/admin/admin.css` |
| the tests | `tests/cp-support.test.mjs` |
| the browser gate's leg | `scripts/verify-admin.mjs` (`panel-support` in the panel walk) |
| the worker | the operator's own Cloudflare account. Section 6 |
