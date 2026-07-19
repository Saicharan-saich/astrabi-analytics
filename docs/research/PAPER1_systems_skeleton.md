# Paper 1 — Systems paper skeleton (hand-off document)

**Status:** ready to write. Core evaluation infrastructure already exists in this
repo (`research/accuracyStudy/`, `__tests__/accuracyStudy.test.ts`,
`docs/research/STUDY1_accuracy.md`). The one missing empirical piece is the naive
LLM baseline run (needs an API key). Everything below is scoped so the
consultancy can start drafting immediately.

---

## Working title

**"Prepare, then Ask: Deterministic, Privacy-Preserving Data Preparation for
Trustworthy Natural-Language Analytics on Messy Business Data"**

(Alternatives: *"Clean Loudly, Compute Deterministically: …"* / *"Silent Errors
in AI Analytics and How to Prevent Them"*.)

## The one-sentence contribution

We show that placing **deterministic, LLM-free data preparation** and a
**hybrid interpret-then-compute** pipeline in front of natural-language analytics
prevents a measurable, under-studied class of **silent errors** (wrong-but-
plausible answers) — while sending **zero data rows** to the language model.

## Framing discipline (READ FIRST — this is what keeps it publishable)

- **Do NOT lead with "we separate the LLM from computation."** That pattern
  (LLM emits an intermediate representation → deterministic compilation) is
  already published — BlendSQL, Query Capsules, Memelang, and the IR line in the
  text-to-SQL surveys. Leading with it invites a novelty rejection.
- **DO lead with three things that are defensible:**
  1. A **taxonomy of silent errors** (wrong-but-plausible answers) that standard
     execution-accuracy benchmarks do not detect.
  2. A **label-free differential oracle** that catches them without hand-written
     gold SQL.
  3. **Deterministic, LLM-free preparation + metadata-only privacy** — most
     prior "LLM for data prep" work puts the model *inside* the cleaning loop;
     we keep it out, which is what makes the numbers trustworthy and private.
- The hybrid architecture is the **mechanism**, cited as building on prior IR/
  compile work — not claimed as the novelty.

## Contributions (as reviewers will read them)

1. **A silent-error taxonomy** for NL analytics: dropped filter, non-additive
   sum, aggregated identifier, wrong aggregation, ignored grouping, hallucinated
   field. Definition: a wrong answer produced by a meaning-level mistake a user
   viewing a single number cannot detect.
2. **A label-free differential evaluation method** (independent recomputation as
   the oracle) that quantifies silent errors without gold queries.
3. **A deterministic preparation + hybrid execution architecture** that reduces
   these errors to (near) zero on the evaluated workload, and a demonstration
   that it also enables a **privacy property** (0 data rows sent to the LLM).
4. **An empirical study** comparing a generic "LLM writes SQL directly" workflow
   against the prepared/hybrid workflow on the same messy inputs.

## System description (Section 3 — draw from the code)

- Deterministic ETL: structural normalization → canonical value prep → column
  profiling → role classification → transformation → **hardening**
  (locale-aware numbers, encoding repair, outlier/typo/sign/range/missing/
  coercion-loss flags) → contract validation. Auditable, lineage-tracked.
  *(Files: `services/etlPipeline.ts`, `services/etlHardening.ts`.)*
- Semantic inference: metric/dimension/date/ID classification with additivity
  behavior (additive / non-additive). *(`services/ai-sql/semanticLayer.ts`.)*
- Hybrid execution: LLM produces a structured intent plan; a **deterministic
  engine compiles the SQL** (with additivity + filter-op + aggregation guards);
  DuckDB executes; result validation. *(`services/ai-sql/intentPlanner.ts`,
  `sqlCorrectionEngine.ts`, `pipeline.ts`.)*
- Privacy: the LLM receives only metadata/shape descriptors, never raw rows.

## Evaluation (Section 4 — the empirical heart)

**Design:** two arms, same messy inputs, same independent JS oracle, same grader.
- **Arm A (baseline):** raw CSV → generic "LLM writes SQL directly."
- **Arm B (ours):** raw CSV → deterministic prep → hybrid interpret-then-compute.

**Primary metric:** silent-error rate by class (the novel lens).
**Secondary:** exact-answer accuracy, query-failure rate, data-quality issues
surfaced, rows-of-data exposed to the LLM (privacy), latency.

**Result table shape (fill Arm A once the API-key run is done):**

| System | Correct | Silent errors | Query failed | Rows sent to LLM |
|---|---|---|---|---|
| A: raw CSV → LLM-writes-SQL | _run pending_ | _run pending_ | _run pending_ | schema only |
| B: prepared → hybrid (ours) | 100% (bank) | 0 (bank) | 0 | 0 rows |

**Instrument validity:** the grader is itself validated (it classifies each
silent-error class correctly on synthetic inputs and never flags a correct
answer). Report this — it is what makes Arm A's numbers credible.

**Ablations:** (i) remove the additivity guard → non-additive-sum errors rise;
(ii) remove deterministic prep (feed raw messy data) → coercion-loss / wrong-type
errors rise. These isolate each mechanism's contribution.

## Related work (Section 2 — position, don't hide)

- **Text-to-SQL & IR-then-compile:** surveys (arXiv 2410.06011, 2407.15186),
  BlendSQL, Query Capsules, Memelang. → *We build on the compile idea; our
  contribution is the silent-error lens + deterministic prep + privacy, not the
  split.*
- **LLM data preparation / wrangling:** the 2026 survey "Can LLMs Clean Up Your
  Mess?" (arXiv 2601.17058), AutoDCWorkflow (2412.06724). → *These put the LLM
  inside the cleaning loop; we keep cleaning deterministic and LLM-free, which is
  what yields auditability and the privacy property.*
- **Self-service BI / NL interfaces to data.** → *Prior systems assume
  analytics-ready data; we target raw, messy business uploads.*

## Honest limitations (Section 6 — state them; reviewers trust it)

- Evaluation bank is small/synthetic and covers each error class; scaling to a
  public benchmark (Spider/BIRD) with both arms strengthens external validity.
- The hybrid engine trades some expressiveness for determinism (it answers what
  the plan schema covers); quantify and discuss the coverage/expressiveness
  trade-off.
- Static silent-error detection is conservative (under-counts) → reported rates
  are lower bounds.

## Target venues

- **Primary:** an applied/industry track — EMNLP Industry, VLDB Industrial,
  CIKM applied, IEEE ICDE, or a data-management-for-ML workshop (DEEM).
- **Preprint:** arXiv first (immediate, citable).

## What the consultancy needs from us to start

1. This skeleton (done).
2. The Arm A run (naive LLM baseline) — needs an API key; the harness is ready
   (`__tests__/accuracyStudy.test.ts` with `OPENROUTER_API_KEY` set).
3. Access to the methodology doc `docs/research/STUDY1_accuracy.md` and the
   taxonomy code for the Related Work / Method sections.

## Immediate next action

Set an `OPENROUTER_API_KEY` and run the head-to-head so Arm A's row is real, then
the results table — the empirical core — is complete and the paper can be drafted
end to end.
