# The community bot pack

The data behind `source/shared/marketplace/community-bots.ts`. Three files, and only one of them is
written by a person.

| File | What it is |
| --- | --- |
| `bots.json` | 69 bots scraped from the upstream marketplace on 2026-09-09, **exactly as they came off the wire and never edited afterwards** |
| `SOURCE-README.md` | that scrape's own index, kept verbatim for provenance |
| `overlay.json` | every human decision, each carrying the exact string it replaces and a `why` |

`bots.json` sha256 `7e3378792d408a72ab499fa3b3e80e149d2d22bfaca171eea60a40d4f4371b68`.
`SOURCE-README.md` sha256 `7d2050e7d1b84becf1dd6c9565db58d9a8a83c033e995ee89af650c5abf99fa5`.
`SOURCE-README.md` links to per-bot pages this repo does not carry; read it as a record of what was
taken, not as documentation. Neither of those two files is ours, so neither has been rewritten --
including the vendor names in them, which is the point: the record of what was scraped has to still
match what was scraped, and the SCRUBBING is the generator's job on the way out.

## Why the split

Editing 69 scraped bots by hand is how a catalog rots. Keeping the scrape immutable and putting every
change in one reviewable file means you can always answer "what did the source actually say, and who
changed it, and why". The generator applies its vendor phrase table first and the overlay second, and
it **fails loudly** when an overlay row's `from` is no longer found, so a stale decision cannot sit
there pretending to still apply.

```
node scripts/build-bot-catalog.mjs           regenerate community-bots.ts
node scripts/build-bot-catalog.mjs --check   compare, write nothing, exit 1 on a difference
node --test tests/community-bots.test.mjs    the module is byte identical to a fresh generation
```

Everything else -- the mapping table, the memory split, the cron rules, the drop list, how to add a
bot -- is in `docs/BOTS.md`.
