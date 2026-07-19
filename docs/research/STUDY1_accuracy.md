# Study 1 — Accuracy: hybrid plan-compile vs. naive LLM-writes-SQL

**What this study measures, why it's designed the way it is, and how to reproduce it.**

## The question

When a non-technical person asks an analytical question in plain language, does the
architecture that produces the number matter for *correctness* — and specifically for
the kind of wrong answer the user cannot detect?

## The gap in existing evaluation

The standard way to score a natural-language-to-SQL system (Spider, BIRD, WikiSQL) is
**execution accuracy**: run the generated query, and if its result rows match those of a
hand-written "gold" query, it's correct. That metric is blind to a class of failure that
matters most for self-service analytics: an answer that is the **wrong number but looks
completely plausible**. A business owner staring at a single figure has no way to tell
that a filter was silently dropped, or that a ratio was summed instead of averaged.

We call these **silent errors** and give them a taxonomy so they can be *counted*.

## The silent-error taxonomy

| Class | What the tool did | Why the user can't tell |
|---|---|---|
| `dropped_filter` | A filter stated in the question is missing from the query | The number is just "too big" — looks like a healthy total |
| `non_additive_sum` | Summed a ratio / percentage / rate | A plausible-looking large number that means nothing |
| `aggregated_identifier` | Summed or averaged an ID column | Returns a number, not an error |
| `wrong_aggregation` | Used the wrong aggregate (e.g. SUM where AVG was asked) | Both are numbers in a believable range |
| `ignored_grouping` | Missing GROUP BY — one blended number instead of a breakdown | Looks like a valid total |
| `hallucinated_field` | Referenced a column that doesn't exist | Often *does* error — but not always, if a similar name exists |

Definition used throughout: **a silent error is a wrong answer produced by a meaning-level
mistake that a user viewing a single number could not detect.** A *right* answer is never
counted as an error, however it was produced.

## Design

Two arms, the **same questions**, the **same dataset**, the **same independent oracle**,
and the **same grader**:

- **Hybrid arm** — each question's structured plan is compiled to SQL by the deterministic
  engine (`services/ai-sql/sqlCorrectionEngine.correctSQL`) and executed in DuckDB. This
  isolates our actual contribution — the plan→SQL compilation and its correctness guards —
  from natural-language parsing, by using a correct plan as the input (see *Scope* below).
- **Naive arm** — an LLM is given the schema and the question and asked to write SQL
  directly, which is then executed on the same DuckDB. This is how most "AI analytics"
  tools work today.

**Ground truth** for every question is computed independently in plain JavaScript from the
raw rows (`research/accuracyStudy/bank.ts`), so no system's own SQL is ever trusted to
define correctness. The **grader** (`research/accuracyStudy/taxonomy.ts`) decides
correctness first, then attributes any wrong answer to a silent-error class.

## The instrument is validated

A benchmark is only as trustworthy as its grader. `__tests__/accuracyStudy.test.ts`
feeds the grader synthetic SQL exhibiting each silent-error class and asserts it
classifies every one correctly — and, critically, that it **never flags a correct answer**
as an error. Only once the instrument is proven do the arm numbers mean anything.

## Result (hybrid arm, reproducible today)

Run headless with no API key, the deterministic arm is measured end-to-end:

| System | Correct | Silent errors | Other wrong | Query failed | Raw data sent to LLM |
|---|---|---|---|---|---|
| Hybrid (plan → deterministic SQL) | **10/10 (100%)** | **0** | 0 | 0 | **0 rows — metadata only** |
| Naive (LLM writes SQL directly) | *requires API key — see below* | | | | schema only |

The live table is regenerated into `STUDY1_results.generated.md` on every test run.

## Running the naive arm (the head-to-head)

The naive arm calls a real model, so it needs an API key. With one set, the same command
runs both arms and fills the naive row from the model's real output — never fabricated:

```bash
OPENROUTER_API_KEY=sk-... NAIVE_STUDY_MODEL=anthropic/claude-sonnet-5 \
  npx vitest run __tests__/accuracyStudy.test.ts
```

## Scope and honest limitations

- **What this arm measures:** the correctness of the plan→SQL **execution** layer — our
  contribution — given a correct plan. It is deliberately *not* an end-to-end test of the
  LLM planner's natural-language understanding; that is a separate concern with its own
  guards (`intentPlanner` normalisation + fallbacks) and its own tests.
- **The bank is small and synthetic** (10 questions, one dataset) — sized to cover every
  silent-error class, not to claim broad coverage. Scaling to a public benchmark (Spider /
  BIRD dev split) with both arms is the natural next step and strengthens external
  comparability.
- **Static silent-error detection is conservative** — it is designed to under-count rather
  than over-count, so reported silent-error rates are lower bounds.

## Files

```
research/accuracyStudy/
  taxonomy.ts     — silent-error classes, detector, grader (the instrument)
  bank.ts         — dataset generator, questions, JS ground-truth oracle, plans
  runStudy.ts     — runs both arms, tallies, formats the report table
  naiveAdapter.ts — the LLM-writes-SQL baseline (API-key gated)
__tests__/accuracyStudy.test.ts — runs the hybrid arm + validates the grader
```
