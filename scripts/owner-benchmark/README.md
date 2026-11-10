# QuickInsight owner benchmark

77 questions worded the way small-business owners type them ("how much did we take last week?",
"which site took more money last month?", "how many customers have ordered more than once?"),
on three exports laid out like the real thing:

| File | Layout | Questions |
|---|---|---|
| `cafe_square_items.csv` | Square item sales: two sites, refunds as negative lines, card-on-file customers, Date + Time | 27 |
| `shop_till_export.csv` | Till export: receipts with several lines, cost price, staff, UK dates, closed Mondays | 25 |
| `shopify_orders.csv` | Shopify orders: order fields on the first line only, discount codes, refunds, 12 months | 25 |

Every file ends on Wednesday 4 Nov 2026, so "this week", "last week", "last month" and "yesterday"
are all tested against a week that is not finished.

## Build

Run from a scratch folder:

1. `python3 gen_raw.py .` writes the three seeded CSVs (made-up businesses and people).
2. `etl.ts` cleans each one with the app's own parser and cleaner, exactly like an upload
   (bundle and run with any TS runner; writes `ds_<name>.json`).
3. `questions.py` holds the questions. Each has DuckDB gold SQL, a separate pandas calculation,
   and other readings an owner could fairly mean ("sales" after or before discounts; the top item
   alone or the top 10), each with its own SQL and pandas calculation.
4. `python3 freeze.py` works out every answer with pandas (the data read as the app loads it:
   blank text is blank) and writes `expected.json`.
5. `python3 emit.py` writes `public/benchmarks/owner-v1/datasets/*.json.gz` and
   `services/benchmark/ownerFixtures.generated.ts`.

## How the answers are checked

- **Two engines.** The frozen answers come from pandas. `__tests__/ownerBenchmarkGold.test.ts`
  runs every gold query and every other reading in DuckDB on CI and requires the same answer,
  and that no top-N cut-off splits a tie. The app re-runs the gold SQL in DuckDB again before it
  scores each case.
- **Readings.** An answer passes if it matches the main reading or any listed one. A reading that
  gives the same answer as another is dropped.

## Run it

Open the app signed in as an admin with `?qi-accuracy` in the address, then in the console:
`__qiAccuracy.start({ suite: 'owner' })`, then `__qiAccuracy.status()` and `__qiAccuracy.summary()`.
