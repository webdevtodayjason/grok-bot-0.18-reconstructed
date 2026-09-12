# SPEND-2: tokens by provider on the Spend panel

Jason (2026-09-12): "Are we able to track tokens used and the provider that they're using them from?"
Today the admin Spend panel (api.titanium.bot/admin#panel-spend) shows dollars per workspace by model
from the metering proxy's spend rows. The rows already carry prompt_tokens, completion_tokens,
total_tokens, model and the provider (cp/proxy.mjs around line 780 reads them). Show them.

## What to build
- In the spend answer (cp/admin.mjs, the `spend:` object near line 2042 and byTenant near 1277):
  per workspace, an array `usage` of rows { provider, model, tokensIn, tokensOut, calls, cost } for
  the current month, sorted by cost desc; plus workspace totals { tokensIn, tokensOut, calls, cost }
  and fleet totals by provider. Provider comes from the proxy's row (custom_llm_provider or the
  deployment's provider); when it cannot be named, the row says "not recorded" and is still counted.
- In the panel (cp/admin/admin.js, spendChips/spendHeadline near 1868 and the per-workspace cards):
  three header cards this month: Tokens in, Tokens out, Cost, each with the top provider under it;
  per workspace a small table Provider · Model · In · Out · Calls · Cost, with a "by provider" total
  row; numbers formatted with Intl (thousands separators, k/M when over 6 digits in the chips, full
  in the table). Nothing invented: a workspace with no rows says "no usage recorded this month".
- Keep every existing chip and behaviour. Same quiet style as the rest of the admin (plain words,
  no prefixed error-looking lines).
- Tests: the existing admin tests get a fixture with three spend rows across two providers and assert
  the usage table and the totals; the proxy reader gets a test for a row missing token fields
  (counts as 0, never NaN).

## Verify
`node --test tests/admin*.test.mjs tests/proxy*.test.mjs` (whatever exists for cp), `node --check` on
the two files, and `npm run lint` if present. Write docs/SPEND-2-REPORT.md (short). Never launch a
browser, docker, or any GUI. Do not commit. Do not touch anything outside cp/.
