# Marketplace logos: where each file came from, and under what licence

Every image the Marketplace draws is **in this directory**. The console fetches nothing from the
internet — it is served by the relay from `ui/machine-room/`, the same way `app.js` is, and a box
with no outbound network paints the whole panel. A plugin or bot with no file here keeps the drawn
letter (or the drawn face) it has always had; the image is an upgrade to the tile, never a
requirement of it.

The catalog names these files by a path relative to `/machine-room/`
(`marketplace/logos/<plugin-id>.svg|png` for a plugin, `marketplace/logos/bot-<bot-id>.png` for a
bot template) in `source/shared/marketplace/catalog.ts`. `tests/marketplace-logos.test.mjs` fails
if a path in the catalog has no file here, or if a file here is not named below.

**Trademarks.** Each mark below belongs to the company it names. Nothing here implies endorsement,
sponsorship or affiliation: the logo is on the card only to identify which service that card
installs, which is what the card is for.

## Plugin logos

| File | What it is | Source | Licence |
| --- | --- | --- | --- |
| `github.svg` | GitHub's Octocat mark on a white plate | `third_party/github/assets/logo.svg` in [cursor/plugins](https://github.com/cursor/plugins) | MIT, Copyright (c) 2026 Cursor (`third_party/github/LICENSE` in that repo) |
| `linear.svg` | Linear's mark in Linear's `#5E6AD2`, path unmodified, placed on a 192×192 white plate | [Simple Icons](https://simpleicons.org), `https://cdn.simpleicons.org/linear` | CC0-1.0 (the Simple Icons collection) |
| `google.svg` | The Google "G" in `#4285F4`, path unmodified, on a 192×192 white plate — the Google Workspace card | [Simple Icons](https://simpleicons.org), `https://cdn.simpleicons.org/google` | CC0-1.0 (the Simple Icons collection) |
| `coderabbit.svg` | CodeRabbit's mark in `#FF570A`, path unmodified, on a 192×192 white plate | [Simple Icons](https://simpleicons.org), `https://cdn.simpleicons.org/coderabbit` | CC0-1.0 (the Simple Icons collection) |
| `localfiles.svg` | The Model Context Protocol mark, path unmodified, on a 192×192 white plate — the Filesystem card is MCP's own reference server | [Simple Icons](https://simpleicons.org), `https://cdn.simpleicons.org/modelcontextprotocol` | CC0-1.0 (the Simple Icons collection) |

**Custom MCP server** deliberately has no file: it is not a vendor, it is the card that opens the
connector editor, and its `+` reads better than any mark would. **GitHub CLI (gh)** deliberately has
no file either, though `github.svg` is right here: the same Octocat on two cards in the same
Development section is the one confusion that card exists to avoid, so it keeps its `gh` tile.

**The white plate.** Simple Icons ships a single-colour path with a transparent background. Four of
the marks above are the vendor's brand colour, which is also the colour of the tile the catalog
gives that plugin (Linear's `#5E6AD2` on Linear's `#5e6ad2` tile would be invisible). Each is
therefore placed, path unmodified, on a 192×192 white square the way cursor/plugins draws its own
third-party logos, so every logo on the page reads as the same kind of object.

## MARKET-6: eleven new cards, no new marks

MARKET-6 took the catalog from ten rows to nineteen. **Not one of the new rows ships a vendor
mark**, and that is a decision rather than an omission.

The rule this directory now runs on: **a letter tile is the default, and a vendor's mark ships only
when that vendor's own brand terms have been read and the permission quoted in a row of this file,
beside the source and the licence.** Simple Icons publishes its SVG collection under CC0, and CC0
on a path is not a trademark licence — that distinction is exactly what the Slack and TinyFish rows
below record, and it applies identically to every logo somebody might fetch from the same place.

So Notion, Airtable, Todoist, Resend, Stripe, Context7, Exa, DeepWiki, Cloudflare, Playwright and
Browser Use are all drawn as letter tiles. Six of them (Context7, Exa, DeepWiki, Playwright,
Browser Use and the Cloudflare docs card) have no Simple Icons entry at all, so the question does
not even arise. The other five do, and the answer is the same as TinyFish's until somebody reads
their brand terms and can quote a permission here.

The five plugin marks above predate this and keep their rows: each already carries a source and a
licence, and `github.svg` carries an explicit MIT grant from the repository it came from.

A tile is not a downgrade. `tests/marketplace-logos.test.mjs` fails as loudly on an orphaned file as
on a missing one, so a mark and its row land in one commit or neither does.

## Marks this catalog does NOT ship, and why

Three cards carried a real logo and no licence. Both vendors publish terms that answer the question,
and both answers are no, so **Slack**, **TinyFish** and **TinyFish CLI** are back on their letter
tiles and the files are out of this directory. Recorded here so nobody re-adds them from a favicon:

| Mark | Where the answer is | What it says |
| --- | --- | --- |
| Slack | [Slack Brand Terms of Service](https://slack.com/terms-of-service/slack-brand) | "**Most uses require a specific written license**", "Don't use the Slack logo (with or without your company logo)", and "Don't distribute or otherwise make available our logos, marks or assets" — committing the PNG here and serving it is exactly that distribution. |
| TinyFish | [TinyFish Terms of Service](https://www.tinyfish.ai/terms), *Ownership* | Tiny Fish retains all right in "any trademarks, logos, or service marks displayed on the Services", and "**There are no implied licenses in these Terms** and except as expressly authorized by Tiny Fish, you may not make use of the Services, Site Content, and Marks." TinyFish publishes no brand guidelines granting one. |

Either mark can come back the day there is a written permission to name in this table.

## Bot template tiles

All six are `assets/avatar.png` from a **first-party** plugin in
[cursor/plugins](https://github.com/cursor/plugins) — the ones written by Cursor itself, each
directory carrying its own `LICENSE`: **MIT, Copyright (c) 2026 Cursor**. Each was downscaled to
128×128 with `sips -Z 128`; nothing else was changed.

| File | Bot template | Taken from |
| --- | --- | --- |
| `bot-research-desk.png` | Research desk | `continual-learning/assets/avatar.png` |
| `bot-pr-review-desk.png` | PR review desk | `advisor/assets/avatar.png` |
| `bot-ops-watcher.png` | Ops watcher | `orchestrate/assets/avatar.png` |
| `bot-issue-triage.png` | Issue triage | `pr-review-canvas/assets/avatar.png` |
| `bot-inbox-triage.png` | Inbox triage | `create-plugin/assets/avatar.png` |
| `bot-course-note-taker.png` | Course note-taker | `teaching/assets/avatar.png` |

The MIT text those directories carry, in full:

```
MIT License

Copyright (c) 2026 Cursor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The same MIT text and copyright covers `github.svg`, which comes from
`third_party/github/LICENSE` in the same repository.
