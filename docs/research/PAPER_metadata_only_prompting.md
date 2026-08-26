# Metadata-Only Prompting Matches Categorical-Value-Enriched Prompting in a Constraint-Governed Browser-Executed Text-to-SQL System

**Saicharan Saich**  
QuickInsight  
Draft manuscript — 26 August 2026

> **Draft status.** This manuscript reports the automatic results contained in two completed 550-case Benchmark Lab exports: one Private/Strict run and one Better/Enhanced run. It does not report a manually adjusted accuracy score. Author affiliation, venue formatting, the final bibliography style, code/data release details, and any independent reproduction statement must be completed before submission.

## Abstract

Large-language-model (LLM) Text-to-SQL systems can incur substantial inference cost and may disclose database content when prompts include sample rows or categorical value lists. We present QuickInsight, a browser-executed analytics system in which deterministic semantic modelling, typed planning, query contracts, correction, and result checks govern model-generated SQL, while DuckDB-WASM executes queries locally. We evaluate the model-backed AI-SQL path on 550 questions: 200-case subsets of Spider-dev and BIRD-dev and 150 application-curated single-table analytics cases. The paired experiment compares a metadata-only privacy profile with a categorical-value-enriched profile. Metadata-only prompts contain schema and locally derived structural metadata but no raw rows or enumerated categorical domains; value-enriched prompts additionally contain approved categorical domains or capped samples. Under QuickInsight's execution-result comparator, metadata-only prompting achieves 77.45% accuracy (426/550), compared with 77.09% (424/550) for value-enriched prompting. The paired difference is -0.36 percentage points (exact McNemar *p* = 0.868; approximate 95% confidence interval, -2.50 to +1.78 percentage points). The enriched profile consumes 6.16 million tokens, 17.0% more than the metadata-only profile's 5.27 million, without improving aggregate accuracy. Multi-table reasoning remains the largest high-volume error category, at 64.7% and 64.2% respectively. These results show that categorical-domain disclosure provided no measurable aggregate benefit within this constraint-governed architecture. Because the benchmark protocol requires model-backed evidence, the experiment does not isolate the causal contribution or zero-token coverage of the deterministic components; that requires a separate architectural ablation.

**Keywords:** Text-to-SQL, natural-language analytics, privacy-preserving analytics, semantic layer, metadata-only prompting, DuckDB-WASM, execution-result evaluation

## 1. Introduction

Text-to-SQL systems translate natural-language questions into executable database queries. LLM-based approaches such as DIN-SQL [3], DAIL-SQL [4], and C3 [5] have demonstrated that general-purpose models can produce strong SQL when supplied with appropriate schema descriptions, examples, decomposition instructions, and correction procedures. This progress has made natural-language analytics viable for users who do not write SQL, but it also creates practical questions about inference cost, data disclosure, and reliability.

First, every model request consumes tokens. Conversational applications may also resend earlier messages or other session context unless their architecture explicitly treats questions independently. Second, some Text-to-SQL methods use database values, retrieved cells, or example rows to ground entities and literals. Such information can improve disambiguation, but its transmission may be undesirable where uploaded data contains commercial, personal, financial, or health information. Third, syntactically valid SQL can still answer the wrong question. Incorrect aggregation grain, join fan-out, missing `DISTINCT`, inappropriate limits, and incorrectly scoped averages can all produce plausible but incorrect numbers.

QuickInsight addresses these concerns through architectural separation. In the normal product flow, uploaded data is prepared locally through automatic and user-governed ETL and cleaning facilities. Both the deterministic Question Builder and AI SQL operate on the resulting typed analytical dataset. For AI SQL, local engines build a semantic model and typed analysis plan, establish an answer contract, and construct an independent deterministic SQL candidate. A constrained LLM then receives the question, plan, contract, and permitted metadata. Generated SQL is corrected, validated, and executed locally through DuckDB-WASM. The complete uploaded dataset is therefore used for computation without being placed in the model prompt.

This study asks a deliberately narrow question:

> Within a constraint-governed, browser-executed Text-to-SQL architecture, does disclosing approved categorical value domains improve execution-result accuracy relative to metadata-only prompting?

We compare two privacy profiles on the same 550 case IDs, application version, benchmark suites, model chain, local execution engine, and result comparator. The intended treatment difference is prompt content: the metadata-only profile withholds categorical domains, while the enriched profile provides approved domains or capped samples. The two runs used different shuffled orderings, which does not prevent case-level paired accuracy analysis but does limit causal interpretation of latency and provider-availability differences.

The paper makes three contributions:

1. A paired empirical comparison of metadata-only and categorical-value-enriched prompting within the same governed Text-to-SQL implementation.
2. A detailed account of a hybrid architecture in which deterministic planning and contracts constrain, verify, and provide continuity around LLM SQL generation while execution remains local.
3. A transparent error analysis across 15 query categories, five benchmark suites, three difficulty levels, provider outcomes, token usage, and repair activity.

The contribution is intentionally narrower than claiming the first token-efficient or privacy-aware Text-to-SQL system. DAIL-SQL studies prompt efficiency [4], while CHESS uses retrieval and schema selection to reduce context and model calls [7]. This work instead isolates a specific disclosure decision—categorical value domains—inside one deployed architecture.

## 2. Background and Related Work

### 2.1 Text-to-SQL evaluation

Spider established cross-domain Text-to-SQL evaluation over unseen database schemas [1]. BIRD extended the problem toward larger databases, dirty content, external evidence, and efficiency considerations [2]. These benchmarks have supported rapid progress, but a single reference SQL is not the only valid formulation of many questions. Execution-based evaluation addresses some SQL-form variation by comparing outputs, although it can still be affected by equivalent projections, ties, duplicate handling, numerical tolerance, and errors in benchmark questions or gold queries. Prior analysis of BIRD has documented noise and ambiguity in questions and reference SQL, reinforcing the need to state evaluation rules precisely [9].

The present study does not claim official Spider or BIRD leaderboard scores. It evaluates subsets through QuickInsight's browser-compatible fixtures and its execution-result comparator. The comparator ignores row order, tolerates aliases and numerical representation differences, and can recognise a narrower requested projection when the answer fields requested by the question are present. This makes the metric suitable for product-facing answer evaluation but not directly interchangeable with official benchmark scripts.

### 2.2 LLM-based SQL generation

DIN-SQL decomposes Text-to-SQL into smaller reasoning stages and adds self-correction [3]. DAIL-SQL systematically studies question representation, example selection, prompt organisation, and token efficiency [4]. C3 combines clear prompting, calibration with hints, and consistent output for zero-shot SQL generation [5]. MAC-SQL uses specialised agents for decomposition, schema handling, and refinement [6]. Collectively, this work shows that SQL quality depends not only on the base model but on the structure placed around it.

CHESS retrieves relevant database context, selects a reduced schema, generates candidates, and applies unit-test-style verification [7]. Its results demonstrate the importance of schema selection and context management on large databases. QuickInsight shares the broad principle that a model should receive governed context rather than an indiscriminate representation of the database. It differs in using a browser-local analytical environment, a typed local plan and query contract, and an explicit paired comparison of prompts with and without categorical-domain disclosure.

### 2.3 Data preparation and analytical correctness

SQL correctness is conditional on the analytical dataset. A correct query can still produce an unsuitable business result if a raw upload contains malformed types, inconsistent categories, inappropriate duplicates, or a join at the wrong grain. QuickInsight separates this concern from probabilistic SQL generation. Its upload and ETL environment supports type-safe preparation, duplicate inspection, missing-value handling, string normalisation, outlier inspection, and quality reporting before Question Builder or AI SQL analysis.

The benchmark fixtures in this study are already benchmark-ready. Consequently, this experiment measures question interpretation and query production after the data-preparation boundary; it does not measure QuickInsight's cleaning effectiveness or compare it with the file-analysis behaviour of general-purpose conversational LLMs. That end-to-end comparison is left for future work.

## 3. System Architecture

### 3.1 Data-preparation boundary

QuickInsight's analytical flow begins before AI SQL:

```text
Uploaded file
    -> local parsing and ETL
    -> automatic and user-governed cleaning
    -> typed analytical dataset
    -> Question Builder or AI SQL
    -> local DuckDB-WASM execution
```

This boundary is important. Question Builder and AI SQL query the same prepared dataset rather than independently interpreting and cleaning the file during every question. Cleaning actions are auditable and separate from LLM inference. For the public benchmark experiment, each fixture is loaded directly as a prepared analytical dataset so that data preparation does not confound the Text-to-SQL comparison.

### 3.2 Governed AI-SQL pipeline

For a question and prepared dataset, the current pipeline performs the following stages:

1. **Semantic model construction.** Fields are classified by physical type, semantic type, analytical role, default aggregation, and other local metadata.
2. **Time-context resolution.** Relative expressions are interpreted against the dataset reporting period rather than blindly against the current date.
3. **Local value catalogue and relationship discovery.** These structures remain in the browser and support grounding, join discovery, and diagnostics.
4. **Typed intent planning.** A deterministic planner represents the requested dimensions, metrics, filters, ordering, limit, intent, and result grain.
5. **Local grounding and ambiguity analysis.** Literals present in the question are linked to local columns; material ambiguities may be resolved or surfaced.
6. **Canonical query contract.** The system records the requested answer fields, grouping grain, relationship path, aggregation, ranking, ratio, and cardinality expectations.
7. **Derived-metric and constraint processing.** The system expands governed formulas and applies analytical guardrails.
8. **Deterministic SQL candidate.** The Question Builder compiler attempts an independent query over the supported local surface. In the current AI-SQL flow this is primarily a continuity and verification candidate, not proof that the model call was skipped.
9. **Plan-constrained model generation.** The selected LLM receives the question, typed plan, query contract, relationship metadata, and privacy-profile-specific schema serialisation.
10. **Local correction and validation.** Deterministic normalisers address supported structural patterns and retain syntax, read-only, and contract diagnostics.
11. **DuckDB-WASM execution.** SQL runs locally against the complete prepared data.
12. **Repair and result checks.** Execution errors or suspicious result shapes can trigger bounded repair attempts, after which result-contract checks, confidence scoring, profiling, and visual recommendation run locally.

This design is not a thin wrapper around an LLM. The model is a constrained SQL synthesiser inside a larger deterministic pipeline. At the same time, the experiment reported here should not be interpreted as a routing ablation: Benchmark Lab intentionally requires model-backed evidence, and the production AI-SQL path currently asks the governed model to draft SQL even when the local compiler has produced a continuity candidate.

### 3.3 Typed analysis plan

A representative plan is:

```json
{
  "intent": "ranking",
  "dimensions": [{ "field": "product" }],
  "metrics": [{ "field": "revenue", "agg": "sum" }],
  "filters": [{ "field": "region", "op": "=", "value": "Europe" }],
  "sort": [{ "field": "revenue", "dir": "desc" }],
  "limit": 5,
  "resultGrain": "one row per product"
}
```

The plan makes the intended calculation inspectable before SQL generation. The contract adds a complementary answer-oriented representation: which fields the user asked to see, which fields may be used only as predicates or ordering helpers, whether duplicate output entities are permitted, and whether the answer should be scalar, grouped, ranked, or set-valued.

### 3.4 Deterministic controls

The implementation contains controls for several recurring analytical errors, including:

- aggregation and additivity governance;
- high-cardinality identifier protection;
- result-grain and over-grouping checks;
- boolean, date, ordinal, and identifier constraints;
- local literal grounding;
- canonical intent reconciliation;
- join-path and join-fan-out reasoning;
- null-aware ranking;
- distinct-projection requirements;
- scoped aggregate comparisons;
- SQL read-only and syntax validation; and
- result-cardinality and answer-shape checks.

The present experiment measures the full governed path. It does not estimate the causal contribution of each control, and therefore no per-control accuracy or latency claim is made.

### 3.5 Privacy profiles

The two experimental profiles are defined as follows.

**Metadata-only (Private/Strict).** The model receives no raw rows and no enumerated categorical domain lists. It does receive a metadata serialisation derived locally from the dataset, including column names and types, semantic roles, aggregation guidance, cardinalities, numeric ranges, relationship information, governed metric definitions, and a dataset-relative reporting anchor where relevant. Literals contained in the user's own question, and locally grounded equivalents of those literals, can also appear in the plan and SQL-generation request.

**Categorical-value-enriched (Better/Enhanced).** The model receives the same plan and metadata plus approved categorical domains or capped samples. Identifiers, near-unique fields, and columns detected as sensitive or person-like are excluded. For an eligible column, the current implementation includes at most 50 values and marks whether the list is complete or a partial sample.

In both profiles, uploaded rows and query-result rows remain in the browser. DuckDB-WASM executes SQL locally. The experiment therefore compares categorical-domain disclosure, not “data versus no information”: both profiles contain rich, locally derived analytical metadata.

## 4. Evaluation Method

### 4.1 Research questions

The study addresses three questions:

- **RQ1:** Does categorical-value enrichment improve execution-result accuracy over metadata-only prompting?
- **RQ2:** What token and latency differences are observed between the two profiles?
- **RQ3:** Which query categories and failure modes remain difficult under both profiles?

It does not answer how much deterministic planning improves over an LLM-only baseline, how often a production question can complete with zero model tokens, or how QuickInsight compares with general-purpose LLM analysis of raw, unclean files.

### 4.2 Benchmark composition

| Suite | Provenance | Cases | Characterisation |
|---|---|---:|---|
| Spider-dev subset | 200-case subset derived from Spider-dev [1] | 200 | Research, single- and multi-table |
| BIRD-dev subset | 200-case subset derived from BIRD-dev [2] | 200 | Research, external evidence and multi-table reasoning |
| Spider-Compatible | Application-curated retail analytics | 50 | Curated single-table |
| BIRD-Compatible | Application-curated SaaS analytics | 50 | Curated single-table |
| Spider2-Compatible | Application-curated procurement analytics | 50 | Curated single-table |
| **Total** |  | **550** |  |

The Spider and BIRD components are subsets rather than their complete development sets. The three “Compatible” suites are application-specific and are not official Spider, BIRD, or Spider 2.0 benchmark questions. Results must therefore not be presented as official leaderboard scores.

The 550 cases cover 15 application categories and three difficulty levels. Each case contains a question, fixture database, gold SQL, and frozen expected output. BIRD-derived cases can also include the benchmark's supplied evidence text. Gold SQL and frozen outputs are used only by the evaluator and are not included in model prompts.

### 4.3 Procedure

Two full Benchmark Lab runs were completed using QuickInsight app version 3.0:

- metadata-only run: 25 August 2026, shuffle seed `363082634`;
- categorical-value-enriched run: 25–26 August 2026, shuffle seed `1875492831`.

Both runs used the same 550 source IDs, suite versions, cascading model chain, local pipeline, and comparator. Their order differed because the shuffle seeds differed. Cases were paired by stable source ID rather than run position; there were no missing IDs or question mismatches.

For each case, Benchmark Lab:

1. loads the case fixture into the browser-local database;
2. executes the gold SQL and verifies it against the frozen expected output;
3. reloads the fixture to prevent state contamination;
4. invokes the AI-SQL pipeline under the selected privacy profile;
5. executes candidate SQL locally;
6. compares the candidate result with the frozen gold result; and
7. stores candidate SQL, bounded output evidence, provenance, tokens, latency, confidence, repair attempts, and outcome.

The automatic candidate comparator ignores row ordering, normalises scalar and numerical representations, maps compatible aliases, and permits a narrower requested projection under deterministic conditions. It does not simply compare SQL strings. Because these rules differ from official Spider and BIRD evaluators, we call the primary metric **QuickInsight execution-result accuracy**.

### 4.4 Benchmark evidence rule

Benchmark Lab requires a positive-token, model-backed response for a result to count as AI-SQL benchmark evidence. Genuine provider failures are classified as `llm_unavailable`; local semantic stops and rejected model candidates are classified as `execution_error`. A locally generated continuity query can therefore remain in diagnostic evidence without being counted as a pass when no acceptable model-backed result exists.

This rule makes the reported study an evaluation of the governed model-backed path. It prevents a provider outage from being silently represented as LLM success, but it also means the reports cannot measure deterministic-only coverage or accuracy.

### 4.5 Metrics and statistics

The primary metric is the proportion of all 550 completed cases automatically marked `pass`. We report status counts, accuracy by category, difficulty, and suite, token totals and distributions, end-to-end per-case latency, confidence-score separation, and the final outcomes of cases with repair attempts.

For the paired privacy comparison, an exact McNemar test is applied to discordant outcomes. The effect is reported as the enriched-minus-metadata-only percentage-point difference with an approximate 95% confidence interval. The statistical unit is a benchmark question. Because only one stochastic run was completed for each profile, the interval does not capture run-to-run model variability.

No manually adjusted accuracy is reported. Human adjudication, if performed in a later study, should be pre-specified, blinded where practical, retained case by case, and published separately from the automatic score.

## 5. Results

### 5.1 Overall accuracy and paired comparison

| Metric | Metadata-only | Value-enriched |
|---|---:|---:|
| Completed cases | 550 | 550 |
| Passed | **426** | 424 |
| Execution-result accuracy | **77.45%** | 77.09% |
| Wrong result | 116 | 119 |
| Execution error | 8 | 4 |
| LLM unavailable | 0 | 3 |

The enriched-minus-metadata-only accuracy difference is -0.36 percentage points. Among the 550 paired cases, 407 pass under both profiles and 107 fail under both; 19 pass only under metadata-only prompting and 17 pass only under value enrichment.

| Paired outcome | Cases | Percentage |
|---|---:|---:|
| Both pass | 407 | 74.0% |
| Both fail | 107 | 19.5% |
| Metadata-only pass, enriched fail | 19 | 3.5% |
| Enriched pass, metadata-only fail | 17 | 3.1% |

The exact McNemar test gives *p* = 0.868. The approximate 95% confidence interval for the difference is -2.50 to +1.78 percentage points. The experiment therefore provides no evidence that categorical-value enrichment improves aggregate execution-result accuracy in this architecture.

### 5.2 Accuracy by category

| Category | N | Metadata-only | Value-enriched |
|---|---:|---:|---:|
| KPI | 24 | 100.0% | 100.0% |
| Time filter | 6 | 100.0% | 100.0% |
| Sorting | 3 | 100.0% | 100.0% |
| Distinct | 3 | 100.0% | 100.0% |
| Breakdown | 30 | 96.7% | 100.0% |
| Grouped aggregation | 24 | 87.5% | 83.3% |
| Aggregate filter | 15 | 86.7% | 80.0% |
| Projection | 27 | 85.2% | 81.5% |
| Filter | 81 | 84.0% | 81.5% |
| Aggregation | 67 | 82.1% | 85.1% |
| Ranking | 71 | 77.5% | 77.5% |
| Multi-metric | 3 | 66.7% | 100.0% |
| Multi-filter | 6 | 50.0% | 50.0% |
| Multi-table reasoning | 187 | 64.7% | 64.2% |
| Multi-dimensional | 3 | 0.0% | 0.0% |

Several categories have very small samples and should not support general claims. Among high-volume categories, breakdown is strongest and multi-table reasoning is weakest. Multi-table reasoning accounts for 66 metadata-only failures and 67 enriched failures, making it the largest absolute source of remaining error. Ranking reaches 77.5% in both profiles. Aggregate filters favour metadata-only prompting in this run, while ordinary aggregation favours enrichment, but these category-level differences were not pre-registered as separate hypothesis tests.

### 5.3 Accuracy by difficulty

| Difficulty | N | Metadata-only | Value-enriched |
|---|---:|---:|---:|
| Easy | 275 | 79.3% | 77.1% |
| Medium | 195 | 79.0% | 79.5% |
| Hard | 80 | 67.5% | 71.3% |

Enrichment performs 3.8 percentage points better on the 80 hard cases but 2.2 points worse on the 275 easy cases. Given the single run, multiple subgroup comparisons, and absence of profile-specific repeat runs, these differences are descriptive rather than confirmatory.

### 5.4 Accuracy by suite

| Suite | N | Metadata-only | Value-enriched |
|---|---:|---:|---:|
| Spider-Compatible, curated | 50 | 92.0% | 92.0% |
| Spider2-Compatible, curated | 50 | 92.0% | 94.0% |
| BIRD-Compatible, curated | 50 | 92.0% | 92.0% |
| Spider-dev subset | 200 | 82.0% | 79.0% |
| BIRD-dev subset | 200 | 62.0% | 63.5% |

The three curated suites achieve between 92% and 94%. The BIRD-dev subset is the most difficult, consistent with its higher incidence of domain evidence, schema-linking demands, and multi-table reasoning. These numbers are produced by QuickInsight's comparator on the selected cases and are not official benchmark scores.

### 5.5 Token consumption

| Statistic | Metadata-only | Value-enriched |
|---|---:|---:|
| Total tokens | **5,267,434** | 6,162,277 |
| Mean per planned case | **9,577** | 11,204 |
| Positive-token cases | 543 | 543 |
| Mean per positive-token case | 9,701 | 11,349 |
| Median among positive-token cases | 9,126 | 9,930 |
| P90 | 13,129 | 15,145 |
| P95 | 14,968 | 19,205 |
| Observed minimum, positive cases | 6,580 | 6,671 |
| Observed maximum | 19,575 | 44,101 |

Value enrichment consumes 894,843 additional tokens, an increase of 17.0% relative to metadata-only prompting. Equivalently, metadata-only prompting consumes 14.5% fewer tokens relative to the enriched total. The observed ranges are empirical properties of these runs, not guaranteed architectural bounds.

The metadata-only run contains 542 results satisfying the runner's model-backed definition; the enriched run contains 543. Seven cases in each report record zero tokens. In the metadata-only run these seven finish as execution errors. In the enriched run, four finish as execution errors and three as provider-unavailable outcomes.

### 5.6 Latency

| End-to-end case latency | Metadata-only | Value-enriched |
|---|---:|---:|
| Mean | 14.4 s | 13.4 s |
| Median | 12.1 s | 10.7 s |
| P95 | 31.2 s | 31.1 s |

The enriched run has lower mean and median per-case latency despite its larger prompt token total, while P95 latency is nearly identical. The profiles were executed at different times and in different shuffled orders. Provider load, retries, caching, and model-chain behaviour were not controlled independently, so the latency difference should not be attributed causally to privacy profile.

### 5.7 Failure patterns

The native outcome totals show that value/projection/row-set disagreement—not syntax rejection or safety withholding—is the principal residual problem. Neither run contains an `invalid_sql`, `withheld`, or `fixture_error` final outcome. A post-hoc grouping of comparator reasons divides wrong-result cases as follows:

| Automatic failure grouping | Metadata-only | Value-enriched |
|---|---:|---:|
| Row-count mismatch | 66 | 66 |
| Other value or projection mismatch | 50 | 53 |
| Execution error | 8 | 4 |
| Provider unavailable | 0 | 3 |

Row-count mismatches are consistent with errors in distinctness, grouping grain, ranking cardinality, set semantics, joins, or limits, but the aggregate counts alone do not establish a unique cause. A publishable root-cause taxonomy would require retained case-level labels and an explicit coding protocol.

### 5.8 Confidence separation and repair activity

| Metric | Metadata-only | Value-enriched |
|---|---:|---:|
| Mean confidence, passed cases | 74.9 | 75.0 |
| Mean confidence, scored failed cases | 58.6 | 60.3 |
| Mean separation | 16.3 | 14.7 |
| Cases with at least one repair attempt | 28 | 33 |
| Repaired cases ending in pass | 18/28 (64.3%) | 21/33 (63.6%) |

The confidence score separates passed and failed cases directionally, but the mean gap is not by itself evidence of calibration. Reliability diagrams, expected calibration error, Brier score, and selective-risk curves would be required before describing the score as calibrated. Likewise, the repair table is observational: it reports the final status of cases with repair activity and does not prove that the repair alone caused the pass.

## 6. Discussion

### 6.1 Categorical values did not improve aggregate accuracy

The primary result is a negative one: categorical-value enrichment changes which individual cases pass, but it does not improve the aggregate score. The two profiles disagree on only 36 of 550 cases, and the 17 enrichment-only gains are offset by 19 metadata-only gains. The paired test and interval are consistent with effects in either direction small enough that this experiment cannot distinguish them.

One plausible explanation is that the governed plan, schema relationships, cardinalities, metric guidance, and query contract already provide much of the structural information required for SQL generation. Under that interpretation, categorical lists add prompt volume without consistently resolving the remaining difficulties, many of which concern projection, grain, joins, set operations, and scoped aggregation rather than literal spelling. This explanation is plausible but not causally established because the study does not ablate the plan or constraints.

### 6.2 Privacy and cost trade-off

The metadata-only profile avoids enumerated categorical domains and reduces token use. It should therefore be the default privacy-cost profile when aggregate accuracy is the decision criterion. However, the result does not show that values are never useful. Seventeen cases pass only under enrichment, and the hard-question subset performs somewhat better. A future adaptive policy could disclose approved domains only when local diagnostics predict literal-grounding uncertainty, rather than attaching them to every eligible request.

The privacy claim must also remain precise. Metadata-only prompting does not mean that the model receives no information derived from the dataset. It receives structural statistics and analytical metadata, and the user's question can itself contain sensitive literals. The measured distinction is the absence versus presence of enumerated categorical domains and samples; it is not a formal information-theoretic non-disclosure guarantee.

### 6.3 The role of deterministic governance

The architecture's deterministic components operate before and after model generation. They create a typed representation, establish requested output grain and cardinality, provide an independent SQL candidate, and validate or repair supported patterns. This makes QuickInsight materially different from a direct question-plus-schema wrapper.

Nevertheless, the present experiment evaluates the combined governed path. It cannot tell us how accurate the same model would be without the plan, how many errors the correction layer prevents, or how often the local compiler could answer correctly without an LLM call. Those questions require an ablation with at least four profiles: LLM-only, local-plan-plus-LLM, full governed pipeline, and deterministic-only eligibility.

### 6.4 The data-preparation advantage is outside this experiment

QuickInsight normally analyses a locally prepared dataset shared by Question Builder and AI SQL. General-purpose conversational LLM file analysis may instead combine preparation, interpretation, and computation within one model-mediated workflow. That architectural contrast is important, but the current clean-fixture benchmark does not test it.

A fair end-to-end study should give the same deliberately corrupted raw files to QuickInsight and general-purpose LLM baselines. It should include both an ordinary upload-and-ask baseline and a stronger baseline explicitly instructed to profile and clean before answering. Gold answers should be computed from independently verified canonical datasets. Such a study could measure silent numerical errors, cleaning decisions, reproducibility, token use, and data disclosure without weakening the internal validity of the present Text-to-SQL experiment.

### 6.5 Remaining technical bottlenecks

The most important high-volume limitation is multi-table reasoning. Failures can arise from selecting the wrong physical table, choosing an incorrect relationship path, losing the population required for an anti-join, or aggregating after a one-to-many join. Ranking and row-count failures also indicate unresolved distinctions among entity projection, grouped aggregation, top-*k* ranking, ties, and helper metrics.

The fact that 107 cases fail in both profiles is especially informative. These common failures are unlikely to be fixed merely by adding categorical values. Development effort should instead target relationship ownership, result grain, projection discipline, set semantics, scoped reference populations, and post-execution semantic verification.

## 7. Threats to Validity and Limitations

1. **Subsets and curated cases.** Only 200 Spider-dev and 200 BIRD-dev cases are included, alongside 150 application-curated cases. The sample is not a substitute for full official benchmark evaluation.
2. **Custom comparator.** QuickInsight's user-answer comparator differs from official Spider and BIRD evaluators. Scores are internally comparable but should not be placed directly on public leaderboards.
3. **Single stochastic run per profile.** The paired test treats questions as paired observations but does not capture run-to-run model variability. Repeated, counterbalanced runs are required for stronger inference.
4. **Different run order.** The profiles use different shuffle seeds. Accuracy pairing remains valid by case ID, but latency and provider outcomes can be order-confounded.
5. **One model chain and application version.** Results may change with models, prompts, provider routing, or subsequent application revisions.
6. **Benchmark-ready fixtures.** The study begins after the data-preparation boundary and does not evaluate automatic cleaning of messy uploads.
7. **Metadata is data-derived.** Strict prompts withhold raw rows and categorical domains but contain locally derived statistics and dataset-relative time metadata.
8. **No component ablation.** The study cannot attribute accuracy to deterministic planning, contracts, correction, or the LLM independently.
9. **No external system baseline.** The experiment compares two modes of one implementation, not QuickInsight against other Text-to-SQL products or general-purpose LLMs.
10. **Bounded evidence rows.** Benchmark exports retain only a bounded number of result rows for case-level inspection. Automatic comparison occurs against the complete runtime result before evidence truncation, but later manual adjudication of large results may require hashes or full projected outputs.
11. **No manually adjusted score.** Potential benchmark noise or semantically acceptable alternative projections are not converted into additional passes in the primary result.

## 8. Future Work

The immediate next experiments are:

1. **Architectural ablation.** Compare LLM-only, local-plan-plus-LLM, full governed pipeline, and deterministic-only eligibility on identical cases.
2. **Repeated paired privacy runs.** Use the same order within each pair, multiple seeds, and unchanged model parameters to estimate stochastic variability.
3. **Official full-suite evaluation.** Run complete Spider-dev and BIRD-dev sets with their official evaluation tools alongside the product comparator.
4. **Adaptive value disclosure.** Share approved domains only when local grounding confidence indicates that their expected benefit exceeds their privacy and token cost.
5. **Messy-data end-to-end study.** Compare QuickInsight's prepare-then-query workflow with ordinary and cleaning-instructed general-purpose LLM baselines on controlled data corruption.
6. **Confidence evaluation.** Measure calibration, selective accuracy, and review workload under confidence thresholds.
7. **Multi-table governance.** Improve relationship ownership, anti-join construction, fan-out prevention, and aggregate scoping.
8. **Reproducibility package.** Publish suite manifests, case-selection procedure, run exports, comparator version, prompt/model configuration, analysis scripts, and hashes of complete result sets.

## 9. Conclusion

This paper evaluated metadata-only and categorical-value-enriched prompting within a constraint-governed, browser-executed Text-to-SQL system. On 550 paired cases, metadata-only prompting achieved 77.45% QuickInsight execution-result accuracy and value enrichment achieved 77.09%. The -0.36 percentage-point difference was not statistically significant, while value enrichment increased token consumption by 17.0% relative to metadata-only prompting.

The result supports a practical conclusion: in this architecture and evaluation, categorical-domain disclosure should not be the default mechanism for improving aggregate accuracy. Rich local metadata, typed planning, query contracts, and local execution enable a stronger privacy-cost configuration without a measured loss in overall correctness.

The experiment also identifies the boundary of that conclusion. It does not prove the independent benefit of deterministic planning, does not measure zero-token routing, does not evaluate raw-data cleaning, and does not establish official Spider or BIRD performance. Those are separate empirical questions. Treating them separately is a strength: it permits the present negative result to remain precise, reproducible, and useful while defining the experiments needed to evaluate the broader QuickInsight architecture.

## Data, Code, and Reproducibility Statement

The evaluation uses public-source-derived subsets and application-curated compatible suites implemented in QuickInsight's Benchmark Lab. Before submission, the authors should publish or archive, subject to dataset licences:

- the exact suite manifests and selected source IDs;
- both raw Benchmark Lab JSON exports;
- comparator and runner versions;
- the script used to calculate paired statistics and tables;
- model-chain and prompt-configuration metadata;
- complete or cryptographically hashed result sets; and
- any subsequent human-adjudication record as a separate secondary analysis.

The present manuscript's principal numerical results are derived from the files `1s.json` (metadata-only) and `better221.json` (categorical-value-enriched).

## Ethical and Privacy Considerations

The evaluation concerns database-question answering and does not require transmitting benchmark rows to the model. Metadata-only prompting nevertheless exposes schema names, derived structural statistics, and question text; these can themselves contain commercially sensitive or personal information. Deployment therefore still requires appropriate provider contracts, access control, retention settings, audit logging, and user awareness. Enhanced value sharing must remain opt-in and subject to local sensitivity filters. No claim in this paper should be interpreted as legal or regulatory certification.

## References

[1] Yu, T., Zhang, R., Yang, K., et al. (2018). *Spider: A Large-Scale Human-Labeled Dataset for Complex and Cross-Domain Semantic Parsing and Text-to-SQL Task.* EMNLP. arXiv:1809.08887.

[2] Li, J., Hui, B., Qu, G., et al. (2023). *Can LLM Already Serve as a Database Interface? A Big Bench for Large-Scale Database Grounded Text-to-SQLs.* NeurIPS. arXiv:2305.03111.

[3] Pourreza, M. R., and Rafiei, D. (2023). *DIN-SQL: Decomposed In-Context Learning of Text-to-SQL with Self-Correction.* NeurIPS. arXiv:2304.11015.

[4] Gao, D., Wang, H., Li, Y., et al. (2024). *Text-to-SQL Empowered by Large Language Models: A Benchmark Evaluation.* Proceedings of the VLDB Endowment, 17(5), 1132–1145. arXiv:2308.15363.

[5] Dong, X., Zhang, C., Ge, Y., et al. (2023). *C3: Zero-shot Text-to-SQL with ChatGPT.* arXiv:2307.07306.

[6] Wang, B., Ren, C., Yang, J., et al. (2023). *MAC-SQL: A Multi-Agent Collaborative Framework for Text-to-SQL.* arXiv:2312.11242.

[7] Talaei, S., Pourreza, M. R., Chang, Y.-C., Mirhoseini, A., and Saberi, A. (2024). *CHESS: Contextual Harnessing for Efficient SQL Synthesis.* arXiv:2405.16755.

[8] Raasveldt, M., and Mühleisen, H. (2019). *DuckDB: An Embeddable Analytical Database.* Proceedings of the 2019 International Conference on Management of Data, 1981–1984.

[9] Wretblad, N., Riseby, F. G., Biswas, R., Ahmadi, A., and Holmström, O. (2024). *Understanding the Effects of Noise in Text-to-SQL: An Examination of the BIRD-Bench Benchmark.* arXiv:2402.12243.

## Appendix A. Verified Run Manifest

| Field | Metadata-only | Value-enriched |
|---|---|---|
| Report ID | `benchmark-1787675050248-epbpj1` | `benchmark-1787708854895-ruk3im` |
| App version | 3.0 | 3.0 |
| Scope | Full | Full |
| Planned/completed | 550/550 | 550/550 |
| Privacy field | `strict` | `enhanced` |
| Shuffle seed | 363082634 | 1875492831 |
| Resume count | 1 | 1 |
| Cancelled | No | No |
| Methodology label | Mixed-Suite Execution Accuracy | Mixed-Suite Execution Accuracy |

Both reports contain the same 550 stable source IDs and identical question text for every paired ID.

## Appendix B. Required Architectural Ablation

The following benchmark-only profiles are proposed for a subsequent study:

| Profile | Enabled stages | Principal measurement |
|---|---|---|
| LLM-only | Question + permitted metadata -> LLM -> safety validation -> DuckDB | Baseline model performance |
| Local plan + LLM | Semantic model + typed plan -> LLM -> DuckDB | Incremental planning benefit |
| Full governed pipeline | Current planning, contract, LLM, correction, repair, local execution | Deployed hybrid performance |
| Deterministic-only eligibility | Local planning/compiler only; unsupported cases abstain | Zero-token coverage and conditional accuracy |

Safety and read-only enforcement should remain enabled in every profile. The deterministic profile should report unsupported cases as `not_eligible`, not as incorrect SQL. Pairwise case transitions, token consumption, latency, provider availability, and accuracy should be exported for all profiles.

## Appendix C. Suggested Messy-Data Study

To evaluate the application's data-preparation boundary, create controlled corruptions of independently verified datasets: exact duplicates, business-key duplicates, inconsistent category casing and whitespace, missing metrics, numeric strings, mixed date formats, invalid booleans, outliers, and join fan-out. Compare:

1. general-purpose LLM, raw upload and immediate question;
2. general-purpose LLM explicitly instructed to profile and clean first;
3. QuickInsight's prepare-then-query workflow.

Primary outcomes should include numerical answer accuracy against the canonical dataset, silent-error rate, cleaning-decision accuracy, reproducibility, token use, latency, and rows or values disclosed to the model.
