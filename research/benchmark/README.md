# Benchmark Lab — official datasets & regression

The **Benchmark Lab** (admin sidebar → *Benchmark Lab*) runs text-to-SQL
benchmarks against QuickInsight's live AI-SQL engine and produces an exportable
report (Markdown / CSV / JSON) for research write-ups.

> **Current implementation note:** Research fixtures now preserve their
> original physical tables plus declared SQLite primary/foreign keys. The
> three-model AI route receives metadata and authoritative join paths; SQL and
> result comparison run locally. Older single-table/one-call notes later in
> this historical guide no longer describe the production benchmark path.

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

## Running the official Spider split (500+ real questions)

The Lab does **not** download Spider — you provide the release, one script turns
it into a single importable file, and you run it in the Lab.

### 1. Get the Spider release

Download from the official source (Yale / the Spider repo) and unzip. Standard
layout:

```
spider/
  dev.json                            [{ db_id, question, query }, ...]  (1034 Qs)
  train_spider.json                   (optional, ~7000 Qs)
  database/<db_id>/<db_id>.sqlite     one SQLite file per database (~200 DBs)
```

### 2. Extract to one bundle (reads the SQLite files directly)

Requires Node ≥ 22 (uses built-in `node:sqlite` — no extra installs):

```bash
node research/benchmark/extractSpider.mjs \
  --spider-dir ./spider --split dev \
  --out spider_dev.bundle.json
  # optional: --limit 600   (cap number of questions)
  #           --max-rows 2000  (cap rows per table; see fidelity note)
```

This emits a compact bundle — tables are stored **once per database**, not per
question, so 600 questions across ~20 databases stays small:

```json
{ "suite": "spider",
  "databases": { "<db_id>": { "<table>": [ {col: val}, ... ] } },
  "cases": [ { "db", "question", "goldSQL", "tableCount", ... } ] }
```

### 3. Import & run in the Lab

Open **Spider 1.0 → Import official (JSON)**, pick `spider_dev.bundle.json`, set
**Max questions** to what your credits allow, and press **Run**. Every result is
saved to the **Results Dashboard** and exportable as Markdown/CSV/JSON.

> The older `importSpider.mjs` (dev.json + a hand-made `databases.json`) still
> works if you already have JSON table dumps; `extractSpider.mjs` is preferred
> because it reads the `.sqlite` files for you.

### Cost & fidelity — read before a big run

- **Every question is one live LLM call** through your backend/OpenRouter quota.
  500 questions ≈ 500 calls. Start with `--limit 20` to confirm it works and see
  the per-question token cost, then scale up.
- Gold **and** generated SQL run against the **same** loaded tables, so accuracy
  is measured consistently even if you cap rows with `--max-rows`. Capping can
  drop foreign-key matches (a fact row referencing a dropped dim row), which can
  make some joins empty on both sides — prefer **no cap** for the truest numbers;
  dev databases are usually small enough.

### What to expect (be honest in the paper)

QuickInsight's engine is **single-table**: multi-table cases are denormalized
into one master table (`autoJoinDatasets`, name-match FK inference) and then
answered by the single-table planner. Real Spider is dominated by multi-table
joins, self-joins, set operations (INTERSECT/EXCEPT/UNION) and correlated
subqueries that this path cannot express. **Expect a modest execution-accuracy
number on full Spider, not a leaderboard score** — the value is a truthful
measurement plus the error taxonomy showing *where* it breaks (join grain,
nesting, set ops). Report N (how many questions you ran) alongside the accuracy.

## Running official BIRD (no scripts — load the folder in-app)

BIRD (Li et al., 2023) runs entirely from the browser — no Node step, no JSON
conversion.

1. Download the **Dev** release from https://bird-bench.github.io and unzip it.
   Expected layout:
   ```
   dev/
     dev.json                              [{ db_id, question, evidence, SQL, difficulty }]
     dev_databases/<db_id>/<db_id>.sqlite
   ```
2. In the Lab open **BIRD → Load BIRD folder** and pick the `dev/` folder.
   The app reads `dev.json` + the `.sqlite` files **in your browser** (via sql.js,
   a WASM SQLite reader), attaches BIRD's `evidence` hint to each question, and
   builds the cases. Nothing is uploaded; only column metadata reaches the LLM.
3. Set **Max questions**, press **Run**. Results save to the Results Dashboard.

Notes:
- The first ~300 questions are loaded (only the databases those questions need
  are read, to keep the browser light). BIRD's full dev databases are ~1 GB, so
  run subsets.
- BIRD questions frequently *need* their `evidence` (external knowledge); it is
  appended to the question as `(Hint: …)`, the standard way BIRD is consumed.

## Evaluation metrics

Beyond plain execution accuracy the runner reports:

- **VES (Valid Efficiency Score)** — BIRD's efficiency metric. For each *correct*
  prediction it times the gold and generated SQL and rewards `sqrt(t_gold /
  t_pred)`; VES is the mean of that reward over all cases (incorrect → 0). On the
  tiny built-in packs times are ~0 so VES ≈ accuracy; it becomes meaningful on
  real BIRD-scale data.
- **Test-suite accuracy** — set **Test-suite instances = N** (>1) in the controls.
  Each correct answer is re-checked on N bootstrap-resampled copies of the
  database; it only stays "correct" if it matches gold on **all** of them. This
  removes the false positives of single-instance execution accuracy (two
  different queries coincidentally agreeing on one dataset). No extra LLM calls —
  only the already-generated SQL is re-executed.

  > This is an **approximation** of Zhong et al. (2020) test suites — we resample
  > the loaded data rather than shipping their distilled databases. For the
  > strongest claim, evaluate Spider with the official test-suite databases;
  > cite this as "bootstrap multi-instance robustness" otherwise.

## Spider 2.0 — why there's no auto-extract

Spider 2.0 is a **cloud data-warehouse** benchmark: its workloads target BigQuery
/ Snowflake / DuckDB projects with huge schemas, external files and multi-step
SQL — there is no single `.sqlite` per database to read. `extractSpider.mjs`
only handles Spider 1.0's SQLite layout. For Spider 2.0 you can hand-build a
bundle for the **DuckDB-runnable subset** (Spider2-lite has some) in the same
`{ databases, cases }` shape and import it, but the full benchmark cannot run in
a browser. Say this explicitly in the paper; the built-in "Spider 2.0" pack here
tests its *query patterns* (window functions, nesting), not its cloud workload.

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
