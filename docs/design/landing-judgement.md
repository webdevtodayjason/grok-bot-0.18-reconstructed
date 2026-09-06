# Judgment: landing-a vs landing-b

Judged as a page whose only job is to make an MSP owner, mid-shift, believe Titanium Bot exists
and book a walkthrough.

## Verdict

**A wins as the base. B wins the copy and the type.** Ship A's structure, graft B's honesty
system and measure discipline onto it.

The tiebreak: B's weaknesses are the kind you fix by writing better sentences. A's one
irreplaceable asset, the console in the hero, is the thing sentences cannot produce. A page that
shows the product beats a page that describes it well, and A shows it in the first screen.

## Scored, category by category

**Which one a busy owner trusts** — B. The `Running today` / `Planned` tag on every trust card is
the single most trust-building device on either page, and B uses it six times. B also volunteers
the bad news in the open ("Nightly snapshots and a restore drill... designed and not yet
running") instead of burying it. A tells the same truth but hides it in FAQ item five, which a
scanning owner never reaches. A owner who has been sold vaporware before reads B's labels and
relaxes.

**Which one he remembers** — A. "Workers with their own computers" is the actual product claim and
nobody else says it. B's "A colleague who never sleeps" is the headline every chatbot vendor has
run since 2023; it is well set and completely generic. What sticks from A is the console: worker
rail, a live pulse, `acme.console.titanium.bot` in the chrome, and a receipts panel listing
`atera.tickets.list → 9 rows`. That last panel is worth the whole page.

**Reads as a product that exists** — A, decisively. A hero screenshot with a URL bar and a worker
count reads as software. B's five SVG fragments are lovely and read as illustration, partly
because they arrive one at a time inside a narrative and partly because they are drawn rather than
captured. B also never labels its fragments illustrative while inventing ticket numbers (#4821,
"breach 16:00") and a worker roster. A labels its receipts panel "Illustrative receipts" and then
leaves its own hero console unlabelled, which is the same failure at half the volume.

**Typographic quality** — B, clearly. B has a real system: a `--measure` token at 34rem applied to
every prose block, a serif body at a fluid 17-19px, sans reserved for labels, mono reserved for
times and paths, and a hanging timeline where the timestamp column is the structure. A's one bold
move (uppercase mono display, `line-height:.95`, `letter-spacing:-.03em`) is a real move and it
mostly lands, but it is undermined by hard `<br>` breaks fighting the `clamp()` between 1000 and
1180px, and by `-.03em` tracking on uppercase mono at 4.6rem, which crowds the counters. A also
has no measure on `.cell p` or `.card p`, so those run to whatever the column gives them.

**Honesty against the facts** — B by a clear margin. B tags status per claim, names the five state
components, dates nothing it cannot date, and closes with "Anything not yet running is labelled
planned or coming, on purpose." A is honest in substance but overclaims twice in the section that
matters most: "An agent cannot claim work it did not do, because the chip is not written by the
model." A counted tool result proves something ran. It does not prove the run supports the
sentence. A's own FAQ says this correctly ("That does not make an agent correct"), so the marketing
line contradicts the page's own fine print. B has one unverifiable claim of its own: "Everything
described as running today was measured on the owner's own instance" is a strong evidentiary claim
in a footer, and it needs to be true or gone.

**Theme correctness** — A, with reservations on both. A defines the full palette on `:root` and
redefines it under `prefers-color-scheme: dark`, including a deliberate second set of console
tokens that intentionally do not swap, because the product is dark in both page themes. That is
the right idea. It is undermined by literals outside the token block: `#0a1216` on `.console`,
`#0f1a1f` on `.desktop`, `rgba(255,255,255,.10)` on the console border, `#04191a` inside the dark
media query, `#0e7a72` hard-coded in the logo SVG twice, and the whole wallpaper gradient. B is
worse: it pins `color-scheme:light` at `:root`, defines a `--bold-ink` token and then writes
`#1A0F08` as a literal in the SVG, and pushes roughly thirty hexes into `.ui` classes and inline
fills. B's dark mode also has a visible defect: the figures are fixed dark (#0E1B21) sitting on a
dark paper (#141210), separated only by a box shadow that is invisible on dark. Five of B's six
figures lose their edge in dark mode.

**Responsiveness** — A. Both bodies set `overflow-x:hidden`, which is a mask, not a fix, so I
looked underneath. A does the disciplined thing: `min-width:0` on every grid child that could
overflow, `minmax(0,1fr)` throughout, the 168px worker rail turning into a horizontal scroller
under 760px, the URL in the titlebar dropping under 560px. I found nothing that breaks. B's fixed
width is deliberate and declared, `svg.ui{min-width:470px}` inside `.figwrap{overflow-x:auto}`, but
the consequence is that on a 360px phone every one of five figures becomes its own scroll box,
which is a poor read on the device where a busy owner opens a link. Both hide the nav at narrow
widths and neither replaces it; B at least has a skip link, A has none.

## The one risk each took

**A** bet the page on a hand-built facsimile of the console in the hero, in HTML and CSS, with no
image. It pays off, and it writes a cheque: if the shipped console does not look substantially
like that, the first demo is a credibility loss. That is a product promise rendered in CSS.

**B** bet the page on narrative. "One Tuesday" delays what the product does until beat four, and it
gates the entire section behind `.reveal{opacity:0}` plus an IntersectionObserver. The guard covers
a browser without IO, but any script error, blocked script, or extension that eats the tag leaves
the main section of the page permanently invisible. That risk is not worth the fade.

---

# Synthesis brief

**Base: landing-a.** Keep the hero console, the mono display, the token architecture, and the fact
that it ships with zero JavaScript.

## Three things to graft from B

1. **The status tagging system.** B's `Running today` / `Planned` / `Coming` pill on every trust
   and pricing claim. This is the highest-value thing on either page for this buyer, it costs one
   span and one class, and it turns the backup gap from a liability discovered in the FAQ into a
   visible act of candour. Take B's footer note with it.

2. **The measure discipline.** B's `--measure:34rem` applied to every prose block, and B's habit of
   assigning each family a job (serif for reading, sans for labels, mono for times and paths). A
   has the families right and applies no measure below the lede.

3. **The clock as spine.** B's timestamps as structure (7:15, every 30 minutes, 14:02, 23:04) are
   more concrete than A's `01 / 02 / 03`. Real times make a schedule feel like a schedule. Graft
   the times into A's "How it works" without importing the narrative length.

## Five concrete edits to A

1. **Tokenize the console palette.** Move `#0a1216` (`.console`, line 147), `#0f1a1f` (`.desktop`,
   line 238), the console border `rgba(255,255,255,.10)` (line 145), `#04191a` (line 134) and both
   `#0e7a72` fills in the logo SVG (lines 363, 747) into the `--c-*` block on `:root`. Add a
   comment-free convention instead of the prose comment: name them `--c-surface`, `--c-surface-2`,
   `--c-edge`, `--c-on-teal`, `--brand-mark`. The rule "the product is dark in both themes" should
   live in the token names, not in a comment above them.

2. **Hoist the backup truth and tag every trust row.** Add a fifth row to `.rows` (line 607)
   reading "Nightly snapshots, planned" with the same honest sentence now sitting in FAQ item five,
   and put B's status pill on all five rows and all three pricing cards. Owner-facing effect: the
   one uncomfortable fact is now something you told him, not something he found.

3. **Kill the overclaim, caption the console.** Replace "An agent cannot claim work it did not do,
   because the chip is not written by the model" (line 594) with the FAQ's own careful version:
   the host counts real tool receipts, so you can tell work from a description of work, which is
   not the same as the agent being right. Then add a caption under the hero console matching the
   one already under the proof block: illustrative, drawn from the shape the console records. A
   page selling evidence cannot ship an unlabelled mock.

4. **Typographic pass on `.display`.** Drop the hard `<br>` tags in the h1 and the section heads
   and let the clamp break the lines; add `text-wrap:balance`. Ease tracking from `-.03em` to about
   `-.015em` above 3rem, where uppercase mono starts closing up. Give `.cell p` and `.card p` a
   `max-width:46ch`. Net effect: the bold move survives the 1000-1180px band where the manual
   breaks currently look accidental.

5. **Fix the mobile first screen and the missing nav.** Under 1000px the console currently lands
   after two paragraphs and three facts; reorder so it sits directly under the CTA row and above
   `.hero-facts`, so the proof of existence is on the first phone screen. While in there, add B's
   skip link, and replace the nav hidden at 640px (line 118) with either a wrapping anchor row or a
   persistent primary CTA, because right now the narrow layout has no navigation at all.
