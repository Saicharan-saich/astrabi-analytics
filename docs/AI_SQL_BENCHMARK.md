# AI SQL Benchmark Lab

QuickInsight includes an admin-only, execution-based benchmark lab for measuring the production AI SQL pipeline against deterministic local fixtures. It now exposes two deliberately separate evaluation collections:

- **Product regression:** 150 synthetic compatibility cases used to detect QuickInsight regressions.
- **Research evaluation:** 400 unchanged public development questions with source gold SQL and DuckDB-verified frozen outputs.

## Reported metric

The primary metric is execution accuracy:

```text
correct candidate result sets / completed benchmark questions
```

Candidate SQL is not compared as text. The candidate and gold queries are executed against the same frozen dataset, then their result sets are compared with:

- aggregate-alias normalization;
- numeric absolute and relative tolerance;
- null and scalar normalization;
- order-insensitive value-set comparison for every question (sorting is excluded from execution correctness);
- exact row-count validation; and
- semantic projection of expected columns so a harmless extra evidence column does not fail an otherwise correct answer.

## Included compatibility packs

| Pack | Cases | Purpose |
| --- | ---: | --- |
| Spider-Compatible Foundations v1.0.0 | 50 | Aggregation, grouping, filters, dates, sorting, distinct counts, and Top-N |
| BIRD-Compatible Business Reasoning v1.0.0 | 50 | Business language, value filters, operational metrics, rankings, and aggregate constraints |
| Spider 2.0-Compatible Enterprise Robustness v1.0.0 | 50 | Enterprise procurement, multi-condition, multi-metric, aggregate-filter, and ranked questions |

These are deterministic compatibility packs inspired by public benchmark task families. They are **not** official Spider, BIRD, or Spider 2.0 development/test sets, and their results must not be described as official leaderboard scores.

## Included research subsets

| Pack | Cases | Public split | Selection |
| --- | ---: | --- | --- |
| Spider Public Dev Research Subset v1.0.0 | 200 | Spider `dev` | Deterministic subset of 656 DuckDB-compatible eligible questions |
| BIRD Public Dev Research Subset v1.0.0 | 200 | BIRD `dev` | Deterministic subset of 339 DuckDB-compatible eligible questions |

These cases retain the public source question, source identity, gold SQL, BIRD evidence where supplied, and locally frozen gold output. Source table assets are fetched only when their first case runs, so the research corpus does not increase ordinary application startup cost.

The fixed `quickinsight-research-v1` selector first diversifies across databases and database/table/category combinations, then fills remaining places using a SHA-256 rank over source identity and question text. Eligible fixtures are limited to at most three referenced tables, 2,000 combined table rows, 30,000 cells, and 200 result rows. Every accepted gold query is executed through the repository's DuckDB-WASM build before inclusion. The locked manifest and source checksums are in [`public/benchmarks/research-v1/manifest.json`](../public/benchmarks/research-v1/manifest.json).

These are official-source **public development examples**, but the 200-case selections and QuickInsight runner are project-defined. Report them as **Spider Public Dev Research Subset** and **BIRD Public Dev Research Subset**, never as full development-set or official leaderboard scores.

## Run protocol

1. Log in as an administrator and open **Benchmark Lab** under Views.
2. Run the 5-cases-per-suite smoke test first.
3. For product regression, select the full 50-cases-per-suite scope for the reportable 150-question run.
4. For research evaluation, deselect the compatibility packs and explicitly select one or both 200-case public-development subsets. Report each suite separately.
5. Keep the application open until the run completes. A stop request takes effect after the current isolated question.
6. Export both JSON and CSV evidence and retain the selection manifest with them.

The runner spaces case starts to respect the production AI proxy. AI retries honour the backend's `Retry-After` window. If the LLM becomes unavailable or rate limited after retries, that case is recorded as `llm_unavailable` instead of silently scoring a deterministic continuity fallback as an ordinary AI-backed answer; the remaining planned cases are still attempted.

Benchmark model calls carry an explicit purpose marker and are accepted only when the backend resolves the current database user as an administrator. They use a separate audited `ai_benchmark_query` allowance (600 model calls per day by default, configurable with `ADMIN_BENCHMARK_DAILY_LIMIT`) and a benchmark-specific minute window. Ordinary user quotas and normal AI SQL traffic are unchanged. Because the production route can use three model calls per question, a 150-question run can consume about 450 model calls and a 200-question research suite can consume about 600. Confirm the configured allowance before starting. Any deterministic or zero-token result is labelled `llm_unavailable`; it is never counted as model-backed accuracy evidence. A full run continues after an isolated unavailable case so the remaining questions are still attempted, while the case-level failure and LLM-backed coverage make the outage explicit.

Before every candidate is scored, its gold SQL is executed locally and must reproduce the embedded frozen output. A corrupt gold fixture is recorded as `fixture_error` and is never counted as an AI SQL failure.

## Evidence captured

Each case records the question, suite and fixture versions, gold SQL, candidate SQL, expected and actual output previews, outcome, mismatch reason, pipeline latency, tokens, engine, strategy, model, confidence, and repair count.

The outcome taxonomy is:

- `pass`
- `wrong_result`
- `withheld`
- `invalid_sql`
- `llm_unavailable`
- `execution_error`
- `fixture_error`

The lab also reports valid-SQL rate, safe-answer rate, **LLM-backed coverage**, median and p95 latency, model tokens, average confidence, and failure counts by type. Execution accuracy is value-first: when the locally executed candidate values match the gold values, the case is a `pass` even if the safety or SQL-validation diagnostic raises a warning. Those warnings remain visible and continue to lower their independent rates. A correct deterministic continuity result may still be useful product behaviour, but an infrastructure-triggered deterministic fallback is reported as `llm_unavailable` so it cannot inflate the LLM-backed benchmark.

## Research reporting checklist

Always report:

- the exact run label: **Curated Subset Execution Accuracy**, **Official Public Subset Execution Accuracy**, or **Mixed-Suite Execution Accuracy**;
- suite names and versions;
- QuickInsight application version or commit;
- model route and privacy mode;
- run timestamp and completed question count;
- whether the run was smoke or full;
- valid-SQL and safe-answer rates alongside accuracy; and
- the exported machine-readable evidence.

Do not combine the 150 compatibility cases and 400 official-source subset cases into a single headline accuracy number. Their provenance and purposes differ. Official leaderboard claims still require the complete benchmark dataset, official evaluator, and submission protocol supplied by the maintainers.

## Rebuilding the locked research corpus

The downloaded source archives/databases are intentionally ignored by Git. With the public Spider and BIRD development assets available locally, regenerate the checked-in corpus with:

```powershell
python scripts/build-research-benchmark-packs.py `
  --node "C:\path\to\node.exe" `
  --spider-root ".benchmark-source\spider\spider_data" `
  --bird-root ".benchmark-source\bird\dev_20240627\dev_databases\dev_databases" `
  --bird-manifest ".benchmark-source\bird\dev_20240627\dev.json" `
  --output-root "public\benchmarks\research-v1" `
  --typescript-output "services\benchmark\researchFixtures.generated.ts" `
  --count 200 --max-table-rows 2000 --max-table-cells 30000
```

Regeneration is expected to reproduce manifest SHA-256 `5c892058865e445b922c0ee0c9beea1fb5987d33fb5e7790d4de3659d98d4f60` when the pinned source archives and generator version are unchanged.
