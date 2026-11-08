# QuickInsight business benchmark

85 plain-English business questions on four generated datasets (no real people).

1. `gen_raw.py` — seeded raw data (retail order lines, weekly store sales, appointments, employees).
2. `etl.ts` — cleans each file with the app's own `runETLPipeline`, exactly as an upload would (bundle and run with any TS runner).
3. `questions.py` — the questions and their gold SQL (portable SQLite/DuckDB SQL; DuckDB-only gold is listed in `DUCK_ONLY`).
4. `freeze.py` — runs the gold SQL in SQLite to freeze the expected answers and flags ties in top-N questions.
5. `emit.py` — writes `public/benchmarks/business-v1/datasets/*.json.gz` and `services/benchmark/businessFixtures.generated.ts`.

At run time the app re-executes every gold query in DuckDB and refuses to score a case whose gold
answer differs, so the expected answers are checked by two separate engines.

Run it: open the app signed in as an admin with `?qi-accuracy` in the address, then in the console
`__qiAccuracy.start({ suite: 'business' })`, `__qiAccuracy.status()`, `__qiAccuracy.summary()`.
