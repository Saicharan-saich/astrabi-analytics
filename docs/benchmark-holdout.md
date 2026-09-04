# Original and new benchmark corpora

Benchmark Lab has two independent question-set tabs:

| Tab | Questions | Sources |
| --- | ---: | --- |
| Original 550 | 550 | Existing 150 compatible, 200 Spider Dev, 200 BIRD Dev |
| New 550 · BIRD + Spider 2.0 | 336 runnable; 214 quarantined | Frozen source set: 500 previously unselected BIRD Dev, 50 genuine Spider 2.0 Lite SQLite |

The old fixture definitions and reference answers are unchanged. Both tabs
support Private and Better modes, smoke runs, full runs, custom counts, shuffle,
pause/resume and exports. Switching tabs clears the current suite selection and
selects that tab's suites; it does not delete reports. History/results are scoped
to the selected corpus. The browser retains the existing overall 20-run history
limit, not 20 per corpus. Configuration cannot switch during an active run.

## Oracle-quality gate

The 2026-09-03 case-by-case audit preserves all 550 new questions but permits
only 336 `no_issue_found` cases to enter a scored run. It quarantines 79
confirmed source/fixture/reference defects, 134 cases requiring human
adjudication, and one case that could not be fully verified. Quarantined cases
are not sent to the model and cannot change execution accuracy. `No issue found`
is an engineering audit status, not a claim of formal human certification.

The runnable suite manifest combines the frozen source-manifest identity with
the oracle-audit hash. This makes resume fail safely if either the fixtures or
quality decisions change. Raw automatic scores and later human-adjudicated
scores must be reported separately.

## Meaning of new / unseen

This is a **new application-catalog holdout**, not a training-contamination-free
benchmark. The generator checks source IDs, normalized question strings and BIRD
reference-SQL duplicates against every Git version of the old research manifest
and locally retained run reports. Tests additionally check all old 550 cases.
Public questions may be in model training, and arbitrary historical user chats
cannot be exhaustively ruled out. Questions are neither generated nor rephrased.

Do not tune the product on these answers and later claim that another run is its
first unseen evaluation. The manifest is frozen before any candidate-model calls.
Record the application Git commit with the first Private/Better pair. Reports
record corpus ID, suite versions, manifest hash, privacy mode and shuffle seed.
Resume rejects a different manifest, scope, count, suite selection or privacy mode.

## Evaluation limitations

This is an **oracle-table, DuckDB-adapted public-source subset**. Complete relevant
tables are retained, but table selection uses BIRD gold SQL or the official
Spider 2.0 gold-table list. It does not evaluate full-database table discovery,
BigQuery, Snowflake, or the full Spider 2.0 workflow. Availability, browser resource
budgets and reference integrity constrain selection. Do not directly compare the
old and new corpus scores as if they contained matched questions or difficulty.
Spider 2.0 difficulty/category labels here are locally assigned.

BIRD frozen results are cross-checked against native SQLite and re-executed in
DuckDB at benchmark time. Spider 2.0 references come from the authors' published
CSV files: alternatives, condition-column projections, numeric tolerance and
ordering requirements are recorded. Cases without published SQL do not receive
invented SQL. Their asset bytes are SHA-256 checked before loading. The local
comparator preserves row associations rather than reproducing the upstream
column-independent evaluator. Existing BIRD answer-aware scoring is retained;
Spider 2.0 is scored against its published projected reference alternatives.
The candidate receives the question, official evidence/docs and the production
pipeline's permitted schema/context, **not reference SQL or reference results**.

Fixtures are losslessly gzip-compressed, loaded on demand and checked against
their decompressed JSON checksum. Fixture caching is bounded to three table sets. Existing report evidence previews
remain capped at 50 rows; comparison uses complete in-memory outputs. Published
Spider 2.0 reference alternatives are also retained in case evidence/JSON export.

## Rebuilding (offline model use)

1. Obtain BIRD's official public-dev `dev_20240627` package in
   `.benchmark-source/bird/`, with the same nested database layout used by the
   original research generator.
2. Obtain the official Spider 2.0 Lite SQLite archive linked from the upstream
   README and save it as `.benchmark-source/spider2/local_sqlite.zip`.
3. Run `python scripts/fetch-spider2-benchmark-source.py` to fetch metadata, source
   documents and references from the pinned upstream commit (not moving main).
4. Run `python scripts/build-holdout-benchmark-packs.py --inspect`, then
   `python scripts/build-holdout-benchmark-packs.py --node /path/to/node`.
5. Run the benchmark test files, typecheck and production build.

The builder never calls an LLM. It uses complete source tables, fixed SHA ordering
and a database/category/difficulty coverage pass; it fails instead of padding if
fewer than 550 eligible disjoint cases are available. Native and DuckDB checks
have time limits. Successful offline validation is cached under the ignored source
directory. Rebuilding can change eligibility after a dependency change: review and
version the manifest, never silently replace it during an existing study.

`selection-lock.json` freezes the original 550 source IDs and order. A rebuild
must reproduce that exact set; mutable local benchmark reports cannot replace
questions. SQLite fixture extraction uses `PRAGMA table_xinfo` and an explicit
column projection so generated columns cannot shift adjacent values. Cached
DuckDB validation preserves projection order.

See `public/benchmarks/holdout-v1/manifest.json` for selection, source and asset
hashes, exclusions and budgets, and `NOTICE.md` beside it for attribution/terms.
