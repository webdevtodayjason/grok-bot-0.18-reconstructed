# Vendor documentation, as it read on 2026-09-09

What `node cp/cli.mjs marketplace verify --fixtures` runs against, and what makes that verb an
offline reproduction of a real read rather than a demo.

Each file is a **verbatim excerpt** of one vendor page: the stretches around the anchors that the
marketing rows in `source/shared/marketplace/catalog.ts` actually name, joined with `[…]` where they
are not adjacent. Not the whole page — a quarter of a megabyte of somebody else's documentation does
not belong in this repo, and what an offline run needs is the part a row names. Every file carries
its source URL and the date it was read in an HTML comment at the top.

The name is the first 16 hex of `sha256(url)`, which is what `fixtureKey` in `cp/verification.mjs`
computes, so `fixtureFetcher` finds a page by its address with no index to keep in step.

| File | Page |
| --- | --- |
| `1378cd3938640632.html` | developers.buffer.com/guides/integrations/mcp.html |
| `1cdd9b89cdca9ea7.html` | docs.browserbase.com/reference/api/create-a-session |
| `43663d65866b13f1.html` | developers.buffer.com/guides/api-limits.html |
| `48cf2b768c395621.html` | learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api |
| `817ba9a535abc0da.html` | docs.x.com/x-api/getting-started/pricing |
| `9497214714dae00f.html` | developers.facebook.com/docs/graph-api/changelog |
| `9f87ab09faeccb41.html` | docs.browserbase.com/features/proxies |
| `a55dade3ad9b1596.html` | developers.facebook.com/docs/permissions |
| `c1e723f478959189.html` | developers.facebook.com/docs/instagram-platform/content-publishing |
| `ce73f6e660b6204e.html` | docs.x.com/x-api/posts/creation-of-a-post |
| `fc574112d88b80e1.html` | docs.browserbase.com/guides/authentication |

The table is a convenience and the file headers are the authority: run
`grep -h '^<!-- http' *.html` for the current list rather than trusting this table after an edit.

## Refreshing one

There is no script, on purpose: cutting these is a judgement about which part of a page carries a
fact, and a generator that guessed would quietly produce a fixture that does not contain the thing
it exists to prove.

1. Fetch the page (the same free fetch the job itself uses — never a metered browser run).
2. Reduce it the way `cp/verification.mjs` does: a tag becomes a **space**, runs of whitespace
   collapse. Buffer's plan table is the reason — replaced by nothing, its cells fuse into
   `FeatureFreeEssentialsTeam` and every number in it becomes unfindable.
3. Keep a window around each anchor the row names, wide enough to contain that row's `expected`.
4. Write it under the sha256 name with the URL and the date in a header comment.
5. `node cp/cli.mjs marketplace verify --fixtures` — every fact should read `verified`, and
   LinkedIn's rate limits should read `not-published`.

## What this does NOT prove

That the vendors' live pages still say these things today. That is what the run against the network
is for, and it is the one the control plane does weekly. These files are frozen on the date in their
headers, which is exactly what makes them useful for testing the differ: they only change when
somebody changes them.
