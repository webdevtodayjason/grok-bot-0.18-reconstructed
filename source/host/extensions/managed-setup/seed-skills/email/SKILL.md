---
name: email
description: >-
  Send and answer email from your own address with Resend. Use when you have
  been sent an email, or when the user asks you to email somebody.
---
# Email

You have an email address of your own at this operator's domain. It is your name in lower case with the spaces taken out, at the domain, so an agent called Chief of Staff is `chiefofstaff@example.com`. Mail sent to that address arrives in this conversation as a message that starts with **Email received at**, and it carries the sender, the subject, the date, the Message-ID, the body and a list of anything attached.

You send with Resend's API through your shell. There is no email tool; the whole thing is one HTTP request.

## Before you can send

You need `RESEND_API_KEY` in your shell. Check first:

```bash
test -n "$RESEND_API_KEY" && echo "the key is here" || echo "no key"
```

If it is not there, ask for it with SendMessage and a secret request naming the connector `shell` and the field `RESEND_API_KEY`. The user gets a card to type it into, and the value lands in your shell as an environment variable. It never appears in this conversation.

**Never put the key in a message, a file you write, a commit, or a command you quote back to the user.** Write `$RESEND_API_KEY` and let the shell fill it in. If you ever see the real value in text you are about to send, stop and take it out.

## Send an email

```bash
curl -sS -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Chief of Staff <chiefofstaff@example.com>",
    "to": ["jane@client.example"],
    "subject": "The September numbers",
    "text": "Hi Jane,\n\nHere are the numbers you asked for.\n\nThanks,\nChief of Staff"
  }'
```

- `from` is your own name and your own address. Do not send as somebody else.
- `to` is a list, even for one person. `cc` and `bcc` take lists too.
- `text` is plain text. Add `"html"` as well only when the mail really needs formatting.
- A success answers with an `id`. An error answers with a `message` saying what was wrong, usually an unverified domain or a bad key.

## Reply to an email

A reply is the same request with two differences: the subject starts with `Re:`, and it carries the Message-ID of the mail you are answering so the two sit in one thread.

```bash
curl -sS -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Chief of Staff <chiefofstaff@example.com>",
    "to": ["jane@client.example"],
    "subject": "Re: The September numbers",
    "headers": { "In-Reply-To": "<abc123@client.example>" },
    "text": "Thanks Jane. I have the invoice and will have this back to you tomorrow."
  }'
```

The value for `In-Reply-To` is the `Message-ID:` line of the email you were sent, angle brackets and all. Without it your reply starts a new thread and the person you are answering has to work out what it is about.

Build the JSON with a heredoc or a file when the body is long or has quotes in it, so the shell does not mangle it:

```bash
cat > /tmp/reply.json <<'JSON'
{ "from": "...", "to": ["..."], "subject": "Re: ...", "headers": { "In-Reply-To": "<...>" }, "text": "..." }
JSON
curl -sS -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" \
  --data-binary @/tmp/reply.json
```

## Attachments

Mail that arrives lists what came with it and gives you a download link that expires. Fetch a link only when you actually need what is in the file. To send a file, add an `attachments` list with a `filename` and either a `path` (a URL Resend can reach) or `content` (the file base64 encoded).

## How to behave

- Answer in the sender's own words and keep it short. You are writing as this business, not as a chatbot.
- Do not promise anything you have not checked, and do not invent a date, a price or a number.
- Tell the user what you sent. A one-line summary in the conversation after the send is enough.
- If the mail asks for something you are not sure about, ask the user before you answer it.
