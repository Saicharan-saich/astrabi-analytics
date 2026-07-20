# Benchmark Lab — official datasets & regression

The **Benchmark Lab** (admin sidebar → *Benchmark Lab*) runs text-to-SQL
benchmarks against QuickInsight's live AI-SQL engine and produces an exportable
report (Markdown / CSV / JSON) for research write-ups.

## What ships built in

Small, **self-contained representative** case packs so the Lab runs out of the
box and the CI gate has something deterministic to check:

| Suite | Cases | Notes |
| --- | --- | --- |
| Spider 1.0 | representative | aggregates, GROUP BY/HAVING, ORDER BY/LIMIT, joins |
| Spider 2.0 | representative | nested subqueries, window functions |
| BIRD | representative | numeric reasoning, ratios, derived metrics |
| Internal Sales | representative | star schema — the app's home turf |
| User | you author | question + gold-SQL pairs against your active dataset |

> ⚠️ **For a paper, do not cite accuracy on the built-in packs.** They are tiny
> and hand-authored. Cite numbers from an **official import** (below).

## Evaluation method (execution-based)

For each question: run the **gold SQL** and the **engine-generated SQL**, then
compare their **result sets** — never the SQL strings (different SQL can yield
identical answers). Row order matters only when the gold query has `ORDER BY`.
Multi-table cases are **denormalized into one master table** with the same
`autoJoinDatasets` the product uses, then answered by the single-table pipeline —
this mirrors the shipping data path.

## Running the official Spider / BIRD split

1. Get the official dev split (`dev.json`) and export each database's tables to
   JSON: `{ "<db_id>": { "<table>": [ {col: val}, ... ] } }` (e.g. via
   `sqlite3 -json <db>.sqlite "SELECT * FROM <table>"`).
2. Convert to the Lab's case format:
   ```bash
   node research/benchmark/importSpider.mjs \
     --questions dev.json --databases databases.json \
     --suite spider --out spider_cases.json
   ```
3. In the Lab, open **Spider 1.0 → Import official (JSON)** and pick
   `spider_cases.json`. Press **Run**. The report is saved to the **Results
   Dashboard** and exportable.

Because every question is a live LLM call, run a subset first (`--limit 100`)
and mind the token budget.

## Regression gate (CI)

`.github/workflows/ci.yml` → **Benchmark regression gate** runs
`__tests__/benchmarkRegression.test.ts` on every push. It is deterministic (no
LLM) and fails the build if:

- any built-in gold SQL stops executing, or
- any multi-table case stops reproducing its gold answer through the
  denormalize → single-table path.

This guards the ingestion/join/SQL layer. The **full engine-accuracy gate** (with
the live planner) needs a browser + API key and is run from the Lab; wire it into
a scheduled job with a `GEMINI_API_KEY` secret when you want an accuracy
threshold to block merges.

## Model comparison (Step 7)

Every run records an `engine` label. The built-in engine is
`QuickInsight (Gemini)`. Additional arms (GPT, Claude, Qwen, DeepSeek) require
their own adapters + API keys; add them behind the same `runBenchmark` interface
and tag runs with the engine name so the dashboard can compare like-for-like.
