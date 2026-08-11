# AI SQL Benchmark Lab

QuickInsight includes an admin-only, execution-based benchmark lab for measuring the production AI SQL pipeline against deterministic local fixtures.

## Reported metric

The primary metric is **Curated Subset Execution Accuracy**:

```text
correct candidate result sets / completed benchmark questions
```

Candidate SQL is not compared as text. The candidate and gold queries are executed against the same frozen dataset, then their result sets are compared with:

- aggregate-alias normalization;
- numeric absolute and relative tolerance;
- null and scalar normalization;
- order-insensitive comparison unless ordering is part of the question;
- exact row-count validation; and
- semantic projection of expected columns so a harmless extra evidence column does not fail an otherwise correct answer.

## Included compatibility packs

| Pack | Cases | Purpose |
| --- | ---: | --- |
| Spider-Compatible Foundations v1.0.0 | 50 | Aggregation, grouping, filters, dates, sorting, distinct counts, and Top-N |
| BIRD-Compatible Business Reasoning v1.0.0 | 50 | Business language, value filters, operational metrics, rankings, and aggregate constraints |
| Spider 2.0-Compatible Enterprise Robustness v1.0.0 | 50 | Enterprise procurement, multi-condition, multi-metric, aggregate-filter, and ranked questions |

These are deterministic compatibility packs inspired by public benchmark task families. They are **not** official Spider, BIRD, or Spider 2.0 development/test sets, and their results must not be described as official leaderboard scores.

## Run protocol

1. Log in as an administrator and open **Benchmark Lab** under Views.
2. Run the 5-cases-per-suite smoke test first.
3. Select the full 50-cases-per-suite scope for the reportable 150-question run.
4. Keep the application open until the run completes. A stop request takes effect after the current isolated question.
5. Export both JSON and CSV evidence.

The runner spaces case starts to respect the production AI proxy. AI retries honour the backend's `Retry-After` window. If the LLM becomes unavailable or rate limited after retries, the run pauses immediately instead of silently scoring deterministic continuity fallbacks as ordinary AI-backed answers.

Benchmark model calls carry an explicit purpose marker and are accepted only when the backend resolves the current database user as an administrator. They use a separate audited `ai_benchmark_query` allowance (600 model calls per day by default, configurable with `ADMIN_BENCHMARK_DAILY_LIMIT`) and a benchmark-specific minute window. Ordinary user quotas and normal AI SQL traffic are unchanged. Because the production route uses three model calls per question, a complete 150-question run normally consumes about 450 benchmark calls. Any deterministic or zero-token result stops the run and is labelled `llm_unavailable`; it is never counted as model-backed accuracy evidence.

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

The lab also reports valid-SQL rate, safe-answer rate, **LLM-backed coverage**, median and p95 latency, model tokens, average confidence, and failure counts by type. A correct deterministic continuity result may still be useful product behaviour, but an infrastructure-triggered deterministic fallback is reported as `llm_unavailable` so it cannot inflate the LLM-backed benchmark.

## Research reporting checklist

Always report:

- the exact label **Curated Subset Execution Accuracy**;
- suite names and versions;
- QuickInsight application version or commit;
- model route and privacy mode;
- run timestamp and completed question count;
- whether the run was smoke or full;
- valid-SQL and safe-answer rates alongside accuracy; and
- the exported machine-readable evidence.

Official benchmark claims require running the official dataset and evaluator supplied by the benchmark maintainers. The compatibility lab is designed for repeatable product regression testing and transparent research evidence, not as a substitute for those official evaluations.
